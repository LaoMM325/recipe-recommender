"""
后端入口 —— 由【后端同学】维护
职责：定义 HTTP 接口，接收前端发来的用户条件，返回推荐结果 JSON。

启动方式见 README.md。接口写好后，浏览器直接打开
http://127.0.0.1:8000/docs 就能在线调试（FastAPI 自带）。
"""
import json
import os
import re
import urllib.request
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

load_dotenv()  # 先加载 .env（llm.py 也自己加载一次，重复无副作用）

# ---- 接口分层原则（9.3）----
# · 推荐 / 补菜 = 事实信息 → 只检索（菜谱库 + Tavily 全网真实菜谱），绝不“现编菜谱”；
# · 每日菜谱推荐 = 搭配建议 → 可让大模型生成，但输出必须标注“AI 建议”，
#   且前端为每道菜附“下厨房/B站”检索按钮，真实做法以检索结果为准。
from llm import clean_titles, daily_plan

app = FastAPI(title="食谱推荐后端")

# CORS：允许网页（比如 file:// 打开的 index.html）跨域调用本后端
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 开发阶段全放行，上线前收紧成自己的前端域名
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---- 请求格式（这就是前后端唯一的契约，改这里要通知前端同学）----
class RecommendRequest(BaseModel):
    食材: list[str] = []       # 用户冰箱里有什么
    调料: list[str] = []       # 有什么调料
    厨具: list[str] = []       # 有什么锅碗瓢盆
    可用分钟: int = 30          # 有多少时间做饭
    口味: list[str] = []       # 偏好：下饭/清淡/辣/酸甜...
    忌口: list[str] = []       # 不吃什么、过敏、减脂等


# ---- 接口：POST /api/recommend ----
@app.post("/api/recommend")
def api_recommend(req: RecommendRequest):
    """
    检索式推荐（防幻觉）：
    输入：{食材: [...], 调料: [...], 厨具: [...], 可用分钟: 20, 口味: [...], 忌口: [...]}
    输出：{推荐: [库内菜谱...], 来源: "本地菜谱库(检索)"}
    结果全部来自 data/recipes.json，绝不调用生成模型。
    """
    return recommend_from_library(req.model_dump())


# ---- 健康检查：启动后先访问这个确认服务活着 ----
@app.get("/health")
def health():
    return {"status": "ok", "service": "recipe-recommend"}


# ============================================================
# 大菜谱库接口：前端启动时拉取，替代原来写死在 app.js 里的 26 道
# 数据文件 backend/data/recipes.json，由 tools/generate_recipes.py 批量生成
# ============================================================
LIBRARY_FILE = Path(__file__).resolve().parent / "data" / "recipes.json"


def _load_library() -> list[dict]:
    """每次实时读文件：脚本生成新库后不用重启后端就生效。"""
    try:
        data = json.loads(LIBRARY_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except (OSError, json.JSONDecodeError):
        return []


# ============================================================
# 检索核心（防幻觉的第一道闸门）：
#   - 忌口 = 硬闸门，无论怎样都不放行（涉及过敏与健康）；
#   - 时间 = 半硬闸门，允许「放宽 relax_overrun 分钟」来补菜；
#   - 打分全部由库内字段计算得出，不产生任何库外内容。
# ============================================================
_WEIGHTS = {"ingredient": 0.5, "cookware": 0.15, "keyword": 0.2, "flavor": 0.15}
_FLAVOR_KEYS = ("salty", "sweet", "spicy", "sour", "umami")
AVOID_TAGS = {"高盐", "高糖", "高碘", "高脂", "辛辣", "坚果过敏"}
DIFFICULTY_TAGS = {"简单", "中等", "困难"}


def _search_library(
    *,
    sel_ing: set[str] | None = None,
    sel_cook: set[str] | None = None,
    sel_avoid: set[str] | None = None,
    flavor_targets: dict | None = None,
    keywords: list[str] | None = None,
    max_time: int | None = None,
    relax_overrun: int = 0,
    exclude_names: set[str] | None = None,
) -> list[dict]:
    """遍历菜谱库打分排序，返回 [{percent, over, recipe, reasons}, ...]。"""
    sel_ing = sel_ing or set()
    sel_cook = sel_cook or set()
    sel_avoid = sel_avoid or set()
    exclude_names = exclude_names or set()
    keywords = keywords or []
    flavor_targets = flavor_targets or {}

    scored = []
    for r in _load_library():
        name = str(r.get("name", ""))
        if name in exclude_names:
            continue
        # 忌口硬闸门
        if set(r.get("avoid") or []) & sel_avoid:
            continue
        # 时间闸门
        time = int(r.get("time") or 30)
        over = 0 if max_time is None else time - max_time
        if over > relax_overrun:
            continue

        score, wsum = 0.0, 0.0
        reasons = []
        ing = set(r.get("ingredients") or [])
        if sel_ing:
            wsum += _WEIGHTS["ingredient"]
            hit = len(ing & sel_ing)
            score += _WEIGHTS["ingredient"] * (hit / max(1, len(ing)))
            reasons.append(f"食材命中 {hit}/{len(ing)}")
        cook = r.get("cookware")
        if sel_cook:
            wsum += _WEIGHTS["cookware"]
            has = cook in sel_cook
            score += _WEIGHTS["cookware"] * (1 if has else 0.3)
            reasons.append(f"{cook}已备" if has else f"{cook}未备")
        if keywords:
            wsum += _WEIGHTS["keyword"]
            text = " ".join([
                name, str(r.get("desc", "")), " ".join(r.get("ingredients") or []),
                str(r.get("seasoning", "")),
            ])
            kf = [k for k in keywords if k in text]
            score += _WEIGHTS["keyword"] * (1 if kf else 0.15)
            if kf:
                reasons.append("命中“" + "、".join(kf[:2]) + "”")
        if flavor_targets:
            wsum += _WEIGHTS["flavor"]
            rfl = r.get("flavor") or {}
            diffs = sum(
                abs(int(rfl.get(k, 5)) - int(flavor_targets.get(k, 5)))
                for k in _FLAVOR_KEYS
            )
            fscore = 1 - diffs / (len(_FLAVOR_KEYS) * 10)
            score += _WEIGHTS["flavor"] * fscore
            if fscore >= 0.75:
                reasons.append("口味接近")

        percent = 50 if wsum == 0 else max(3, round(max(0.0, score) / wsum * 100))
        if over > 0:  # 放宽时间捞上来的菜：如实降分并注明
            percent = min(percent, 60)
            reasons.insert(0, f"超时 {over} 分钟（已放宽 {relax_overrun} 分钟内）")

        scored.append({"percent": percent, "over": over, "recipe": r, "reasons": reasons})

    scored.sort(key=lambda x: (x["over"], -x["percent"]))
    return scored


def recommend_from_library(user: dict) -> dict:
    """POST /api/recommend 的检索实现：忌口不放、时间不放，取命中条件的前 5 道。"""
    sel_ing = {str(x) for x in user.get("食材", [])}
    sel_cook = {str(x) for x in user.get("厨具", [])}
    sel_avoid = {str(x) for x in user.get("忌口", [])}
    keywords = [str(x) for x in user.get("口味", [])]
    need_hit = bool(sel_ing) or bool(keywords)

    picked = []
    for x in _search_library(
        sel_ing=sel_ing, sel_cook=sel_cook, sel_avoid=sel_avoid,
        keywords=keywords, max_time=user.get("可用分钟"),
    ):
        if len(picked) >= 5:
            break
        r = x["recipe"]
        text = " ".join([str(r.get("name", "")), " ".join(r.get("ingredients") or [])])
        ing_hit = bool(sel_ing & set(r.get("ingredients") or []))
        kw_hit = any(k in text for k in keywords)
        if need_hit and not (ing_hit or kw_hit):
            continue
        picked.append(r)
    return {"推荐": picked, "来源": "本地菜谱库(检索)", "条数": len(picked)}


@app.get("/api/recipes")
def api_recipes():
    """返回整个菜谱库。前端与内置 26 道按菜名去重合并后使用。"""
    return {"recipes": _load_library(), "total": len(_load_library())}


# ============================================================
# 把“AI 全网检索到的好菜”收录进本地菜谱库（持久化到 recipes.json）
# 只允许存“网页上真实存在的条目”（必须带 sourceUrl），
# 服务器再校验一遍字段并给出安全默认值；此后本地检索也能搜到它。
# ============================================================
class RecipeAddRequest(BaseModel):
    recipe: dict[str, object] = {}


@app.post("/api/recipes/add")
def api_recipe_add(req: RecipeAddRequest):
    lib = _load_library()
    r = dict(req.recipe or {})
    name = str(r.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="菜名不能为空")
    source_url = str(r.get("sourceUrl") or "").strip()
    if not source_url.startswith("http"):
        raise HTTPException(status_code=422, detail="缺少可溯源的来源链接，无法收录")

    # 防重复（按菜名）
    if any(str(x.get("name", "")) == name for x in lib):
        return {"ok": False, "message": f"「{name}」已在本地菜谱库中", "name": name}

    ingredients = [str(i).strip() for i in (r.get("ingredients") or []) if str(i).strip()][:10]
    steps = [str(s).strip() for s in (r.get("steps") or []) if str(s).strip()][:8]
    flavor = {}
    raw_flavor = r.get("flavor") if isinstance(r.get("flavor"), dict) else {}
    for k in _FLAVOR_KEYS:
        try:
            flavor[k] = max(0, min(10, int(raw_flavor.get(k, 5))))
        except (TypeError, ValueError):
            flavor[k] = 5
    avoid = [a for a in (r.get("avoid") or []) if a in AVOID_TAGS][:5]
    difficulty = str(r.get("difficulty") or "简单")
    if difficulty not in DIFFICULTY_TAGS:
        difficulty = "简单"

    item = {
        "id": max((int(x.get("id") or 0) for x in lib), default=0) + 1,
        "name": name,
        "desc": (str(r.get("desc") or "").strip()[:200]
                 or f"AI 从网页检索收录{('于 ' + str(r.get('sourceName') or '')) if r.get('sourceName') else ''}，做法请查看原网页。"),
        "time": None,  # 检索不到精确用时，不编造；前端自动隐藏时间行
        "difficulty": difficulty,
        "cookware": str(r.get("cookware") or ""),
        "ingredients": ingredients,
        "seasoning": str(r.get("seasoning") or ""),
        "flavor": flavor,
        "avoid": avoid,
        "steps": steps,
        "video": False,
        "sourceUrl": source_url,
        "sourceName": str(r.get("sourceName") or "")[:40],
        "fromWeb": True,
    }
    lib.append(item)
    LIBRARY_FILE.write_text(json.dumps(lib, ensure_ascii=False, indent=1), encoding="utf-8")
    return {"ok": True, "message": f"已把「{name}」加入本地菜谱库", "id": item["id"]}


# ============================================================
# AI 补菜接口（防幻觉版，9.3 起）：允许 AI 补菜，但只许“检索”、不许“生成”
#   第一步 · 库内补：时间闸门放宽 15 分钟，从 recipes.json 再捞“差一点就符合”的菜
#   第二步 · 库外补：用网页搜索（Tavily）检索全网真实菜谱，
#           菜名与简介取自搜索结果原文，并带上【来源链接】可点击溯源
#   全程不调用任何“生成菜谱”的模型 —— 库外结果=网页上的真实内容，不是编的
# ============================================================
class SupplementRequest(BaseModel):
    ingredients: list[str] = []   # 选中的食材
    cookware: list[str] = []      # 选中的厨具
    avoids: list[str] = []        # 忌口
    flavors: dict[str, int] = {}  # 口味滑条（salty/sweet/spicy/sour/umami 0~10）
    keywords: list[str] = []      # 自然语言关键词
    maxTime: int | None = None    # 可用分钟
    requestText: str = ""         # 用户原始输入
    count: int = 4                # 要补几道
    excludeNames: list[str] = []  # 已展示菜名，检索时排除避免重复


_TAVILY_URL = "https://api.tavily.com/search"
# 这些站没有结构化菜谱正文，跳过以免补出“打不开原文内容”的卡片
_SOCIAL_HOSTS = {
    "instagram.com", "www.instagram.com",
    "facebook.com", "www.facebook.com",
    "tiktok.com", "www.tiktok.com",
    "weibo.com", "www.weibo.com",
    "douyin.com", "www.douyin.com",
    "xiaohongshu.com", "www.xiaohongshu.com",
    "youtube.com", "www.youtube.com",
}
# 下厨房（用户认可的高质量菜谱源）：库外检索第一优先只在这里搜
XCF_DOMAINS = ["www.xiachufang.com", "m.xiachufang.com"]
_WEB_TITLE_TAIL = re.compile(
    r"[-_|·\s]*(下厨房|豆果美食|心食谱|美食杰|香哈菜谱|网上厨房|搜狐|网易|百家号|知乎|"
    r"百度百科|百度知道|新浪|一点资讯|今日头条|菜谱大全|家常菜做法大全|视频教程)?\s*$"
)


def _tavily_search(query: str, n: int, include_domains: list[str] | None = None) -> list[dict]:
    """调 Tavily 网页搜索，返回真实搜索结果（title/url/content/domain）。
    include_domains 非空时只在这些站点内搜索（比如优先下厨房）。"""
    key = os.getenv("TAVILY_API_KEY", "").strip()
    if not key:
        raise RuntimeError("NO_TAVILY_KEY")
    payload = {
        "api_key": key,
        "query": query,
        "max_results": n,
        "search_depth": "basic",
        "include_answer": False,
    }
    if include_domains:
        payload["include_domains"] = include_domains
    req = urllib.request.Request(
        _TAVILY_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return data.get("results") or []


def _clean_web_name(title: str) -> str:
    """把各种 SEO 长标题清成菜名。

    例：
      “番茄炒蛋｜零失败的做法步骤_下厨房”        -> 番茄炒蛋
      “随便菜谱｜黑巧燕麦蛋糕”                   -> 黑巧燕麦蛋糕
      “蛋糕的做法大全_怎么做蛋糕_做蛋糕的方法”     -> 蛋糕
      “奶油蛋糕怎么做好吃”                       -> 奶油蛋糕
    做法：先剥站点尾缀；按 |｜_ 分段；每段剥废话前缀/后缀；
    动词式碎片（“做蛋糕”等）丢掉，取剩下的名词菜名。
    """
    base = _WEB_TITLE_TAIL.sub("", title.strip())

    _suffixes = (
        "怎么做才好吃", "怎么做好吃", "怎么做才", "才好吃", "更好吃",
        "怎么做好喝", "怎么煮好喝", "好喝", "教程",
        "的家常做法", "的做法大全", "的做法步骤", "家常做法大全",
        "菜谱大全", "大全", "的做法", "做法步骤", "怎么做好",
        "的方法", "方法", "步骤", "零失败", "菜谱", "食谱", "做法", "好吃", "怎么做",
        "的",
    )
    # 段首废话（随便/家常/几分钟快手/怎么做…）——长短语在前
    _lead = re.compile(
        r"^(?:\d+分钟)?(?:快手家常下饭菜|快手家常菜|家常下饭菜|快手下饭菜|"
        r"家常下饭|下饭菜|快手菜|家常菜|快手|家常|下饭|"
        r"怎么做好吃|怎么做|如何做|鲜香味美|巨好喝|超好喝|好喝到|好喝|"
        r"巨好吃|超好吃|好吃到|香浓|喷香|私房|懒人|简单|美味|好吃|零失败|大厨|"
        r"收藏|推荐|学会|教你|食谱大全|菜谱大全|做法大全|创意|随手|一人食|随便|"
        r"[！!]+|的)"
    )

    def _rounds(s: str) -> str:
        """核心清洗轮：剥尾缀 → 剥废话前缀 → 重复直到稳定。"""
        for _ in range(6):
            changed = False
            new = s.rstrip(" _-|｜·")
            if new != s:
                s, changed = new, True
            for suf in _suffixes:
                if s.endswith(suf):
                    s = s[: -len(suf)].rstrip(" _-|｜·")
                    changed = True
                    break
            lead = _lead.sub("", s)
            if lead != s:
                s, changed = lead.strip(), True
            if not changed:
                break
        return s

    def _noise(s: str) -> str:
        """二级噪声：括号食谱标签、营销好处词、装饰符号。"""
        s = re.sub(r"[(（][^)）]*(?:食谱|视频|步骤|做法)[^)）]*[)）]", "", s)
        for w in (
            "不掉皮", "不开裂", "不塌陷", "不回缩", "一次成功", "零失败",
            "松软", "新手", "零基础", "超详细", "图文", "收藏", "教程",
            "做法步骤图", "步骤图", "这样做",
        ):
            s = s.replace(w, "")
        s = re.sub(r"[‼️❗️✨🎉🔥🙌💯😋\u2600-\u27BF\U0001F000-\U0001FAFF]+", "", s)
        return s.strip()

    def _clean_part(part: str) -> str:
        s = _rounds(part.strip())
        s = _noise(s)

        # 处理“【xx】”装饰括号：
        #  - “【步骤图】8寸古早味蛋糕（食谱）” → 真名在括号外，取 outside
        #  - “【蛋糕卷…】MuseFood”              → 外面只剩作者名，取 inside
        m = re.search(r"【([^】]*)】", s)
        if m:
            inside = m.group(1).strip()
            outside = (s[: m.start()] + s[m.end():]).strip()
            outside_has_cjk = bool(re.search(r"[\u4e00-\u9fff]", outside))
            if outside and outside_has_cjk:
                s = outside
            elif inside:
                s = inside
        s = s.replace("【", "").replace("】", "")

        # 括号决定后再清一轮残留（如懒人→蛋糕、尾部步骤残留）
        s = _rounds(_noise(s))

        # 去掉尾部残存的字母/数字（作者名/站点后缀）
        if re.search(r"[\u4e00-\u9fff]", s):
            s = re.sub(r"[A-Za-z0-9\s]+$", "", s).strip()
        return s.strip()

    # 按 |、｜、_ 分段清洗（_ 是 SEO 标题常用分隔：蛋糕的做法大全_怎么做蛋糕…）
    raw_parts = [p for p in re.split(r"[|｜_]+", base) if p.strip()]
    cands = []
    for p in raw_parts:
        c = _clean_part(p)
        # 丢掉动词式碎片 / 空段 / 纯废话
        if len(c) < 2 or c.startswith(("做", "教你", "自", "快来", "跟我")):
            continue
        if c not in cands:
            cands.append(c)
    if cands:
        # 取信息量最大（最长）的候选；同样长取更靠前出现的
        best = max(range(len(cands)), key=lambda i: (len(cands[i]), -i))
        return cands[best][:40]

    cleaned = _clean_part(base)
    return cleaned[:40] or base[:40] or title.strip()[:40]


def _snippet_garbage(text: str) -> bool:
    """摘要是不是“评分/人做过/App 推荐/列表”这类无做法内容。"""
    markers = ("打开App", "评分", "人做过", "做过这个菜", "下载APP", "今日上新", "的菜谱大全")
    return any(m in text for m in markers)


def _web_to_recipe(res: dict, name_override: str | None = None, summary_override: str | None = None) -> dict | None:
    """搜索结果 → 前端菜谱卡片。简介优先用 Agnes 生成的摘要；否则跳过垃圾正文，给兜底文案。
    name_override / summary_override：Agnes 清洗+简介结果（校验通过才传进来）。"""
    url = (res.get("url") or "").strip()
    title = (res.get("title") or "").strip()
    name = (name_override or "").strip()
    if not name:
        name = _clean_web_name(title)  # 正则兜底
    if not name or not url:
        return None
    snippet = (res.get("content") or "").strip()
    host = (res.get("domain") or "").strip()
    try:
        from urllib.parse import urlparse

        host = host or (urlparse(url).netloc or "网页")
    except Exception:  # noqa: BLE001
        host = host or "网页"

    # 简介优先级：Agnes 简介 > 干净正文 > 兜底文案（有垃圾正文绝不展示）
    if summary_override:
        desc = summary_override
    elif snippet and not _snippet_garbage(snippet):
        desc = (snippet[:150] + "…") if len(snippet) > 150 else snippet
    else:
        desc = f"《{name}》收录自 {host}：该网页正文为列表/推荐内容，具体做法步骤请查看原网页。"

    return {
        "name": name,
        "desc": desc,
        "time": None,             # 摘要里没有精确时间，不编造
        "difficulty": None,
        "cookware": None,
        "ingredients": [],
        "seasoning": None,
        "flavor": {"salty": 5, "sweet": 5, "spicy": 5, "sour": 5, "umami": 5},
        "avoid": [],
        "steps": [],
        "video": False,
        "origin": "web",          # 前端据此显示“全网检索”样式
        "sourceUrl": url,
        "sourceName": host,
    }


def _web_recipes(req: SupplementRequest, need: int, exclude_names: set[str]) -> tuple[list[dict], str]:
    """库外检索：给网页搜索构造查询，过滤无关结果，返回 (菜谱列表, 提示语)。"""
    if need <= 0:
        return [], ""
    key = os.getenv("TAVILY_API_KEY", "").strip()
    if not key:
        return [], (
            "未配置 TAVILY_API_KEY，库外检索已跳过（仅返回库内补充）。"
            "免费申请：https://app.tavily.com → 复制 key 填进 backend/.env 的 TAVILY_API_KEY= 即可。"
        )

    ing = [x for x in req.ingredients if x][:3]
    kw = [x for x in req.keywords if x][:2]
    parts = list(ing) + list(kw)
    if req.maxTime:
        parts.append(f"{req.maxTime}分钟内")
    parts.append("家常菜 做法 食谱" if ing else "做法 食谱")
    query = " ".join(parts)

    # 第一步：聚合搜索结果（优先下厨房，不够再全网兜底）
    pool: list[dict] = []
    try:
        pool += _tavily_search(query, max(need * 3, 6), include_domains=XCF_DOMAINS)
    except Exception:  # noqa: BLE001
        pass
    if len(pool) < need:
        try:
            pool += _tavily_search(query, max(need * 3, 6))
        except Exception as e:  # noqa: BLE001
            return [], f"网页搜索失败：{e}（仅返回库内补充）" if not pool else ""

    # 按标题去重
    uniq: list[dict] = []
    seen_titles: set[str] = set()
    for res in pool:
        t = str(res.get("title") or "").strip()
        if not t or t in seen_titles:
            continue
        seen_titles.add(t)
        uniq.append(res)

    # 统一交给 Agnes：清洗菜名 + 若正文可用就生成简介（失败自动回落正则+兜底文案）
    llm_map: dict[str, dict] = {}
    try:
        llm_map = clean_titles(
            [
                {"标题": str(r.get("title") or ""), "摘要": (str(r.get("content") or ""))[:320]}
                for r in uniq
            ]
        ) or {}
    except Exception:  # noqa: BLE001 —— 清洗失败不影响主流程
        llm_map = {}

    # 第二步：转成卡片（Agnes 结果优先，缺的用正则/兜底），再做去重/质量过滤
    items, seen_names = [], set()
    for res in uniq:
        if len(items) >= need:
            break
        raw_title = str(res.get("title") or "").strip()
        info = llm_map.get(raw_title) or {}
        override_name = (info.get("name") or "").strip() or None
        override_summary = (info.get("summary") or "").strip() or None
        item = _web_to_recipe(res, name_override=override_name, summary_override=override_summary)
        if not item:
            continue
        if item["name"] in exclude_names or item["name"] in seen_names:
            continue
        # 质量过滤：社交平台 / 没有摘要正文的链接不放进来
        if item["sourceName"] in _SOCIAL_HOSTS:
            continue
        if len(item["desc"]) < 10:
            continue
        # 相关性：结果里至少该出现一个用户食材/关键词，实在没有再兜底
        hay = f'{item["name"]} {item["desc"]}'
        if ing and not any(x in hay for x in ing) and kw and not any(x in hay for x in kw):
            continue
        seen_names.add(item["name"])
        items.append(item)

    if not items:
        return [], "下厨房与全网都没搜到相关菜谱，试试换个更常见的食材或关键词。"
    return items, ""


@app.post("/api/supplement")
def api_supplement(req: SupplementRequest):
    """AI 补菜（检索式，防幻觉）：
    1) 先从菜谱库放宽时间闸门补；
    2) 不够数时再用网页搜索补真实菜谱（附来源链接）。
    返回 {推荐: [...], 库内补: n, 库外补: n, note: 提示}。
    """
    exclude_names = {x for x in req.excludeNames}

    # ---- 第一步：库内补充（时间放宽 ≤15 分钟，忌口不放行）----
    local = _search_library(
        sel_ing={x for x in req.ingredients},
        sel_cook={x for x in req.cookware},
        sel_avoid={x for x in req.avoids},
        flavor_targets=req.flavors or None,
        keywords=req.keywords or None,
        max_time=req.maxTime,
        relax_overrun=15,
        exclude_names=exclude_names,
    )
    local_items = [x["recipe"] for x in local[: req.count]]
    local_names = {str(r.get("name", "")) for r in local_items}

    # ---- 第二步：库外补足（网页搜索真实菜谱）----
    need = max(0, req.count - len(local_items))
    web_items, note = _web_recipes(req, need, exclude_names | local_names)

    return {
        "推荐": local_items + web_items,
        "库内补": len(local_items),
        "库外补": len(web_items),
        "note": note or None,
        "说明": "库内=放宽时间从本地库检索；库外=网页搜索到的真实菜谱（附来源链接）。全程不生成任何新菜。",
    }


# ============================================================
# 每日菜谱推荐：结合【季节/天气】+【用户账本口味偏好】由大模型生成搭配建议
# 属于“搭配建议型生成”：返回内容标注为 AI 建议，前端附真实做法检索入口
# ============================================================
class DailyRequest(BaseModel):
    # 前端从 localStorage 账本算出来的口味画像
    taste: dict[str, int] = {}        # 咸/甜/辣/酸/鲜 0~10 的加权平均
    topIngredients: list[str] = []    # 常买的食材 TOP5
    topDishes: list[str] = []         # 常做的菜 TOP5
    avoids: list[str] = []            # 忌口（来自当前筛选）
    maxTime: int | None = None        # 可用时间
    hasRecord: bool = False           # 账本里是否有记录
    festival: str = ""                # 节日特供：春节/元宵/清明/端午/七夕/中秋/重阳/冬至/腊八
    count: int = 3                    # 生成几道


# 各传统节日的“应景食物”常识（供 AI 生成节日特供菜单时参考，不虚构）
_FESTIVAL_FOODS = {
    "春节": ["饺子", "年糕", "八宝饭", "红烧鱼(年年有余)", "春卷", "四喜丸子", "腊味拼盘"],
    "元宵": ["汤圆", "元宵", "酒酿圆子", "糖油果子", "蒸年糕"],
    "清明": ["青团", "艾饺", "春卷", "螺蛳", "马兰头拌香干"],
    "端午": ["粽子(甜/咸)", "咸鸭蛋", "绿豆糕", "五黄(黄鱼/黄鳝/黄瓜/蛋黄/雄黄酒)", "艾草糕"],
    "七夕": ["巧果", "馄饨", "江米条", "应季瓜果拼盘"],
    "中秋": ["月饼", "桂花糖藕", "芋艿烧鸭", "菱角", "大闸蟹(应季)", "桂花酒酿"],
    "重阳": ["重阳糕", "菊花酒(以茶代)", "栗子焖鸡", "羊肉汤"],
    "冬至": ["饺子", "汤圆(冬至团)", "羊肉汤锅", "糯米饭"],
    "腊八": ["腊八粥", "腊八蒜", "腊八面", "腊肉/腊肠蒸食"],
}


def _china_now():
    """北京时间优先；机器没装 tzdata 时回退到本机时间（本机即中国时区也一样）。"""
    try:
        from zoneinfo import ZoneInfo

        return datetime.now(ZoneInfo("Asia/Shanghai"))
    except Exception:  # noqa: BLE001 —— 无 tz 数据库等
        return datetime.now()


def _today_str() -> str:
    """“每日菜单”的日期以北京/本地时间为准，不交给模型推算。"""
    return _china_now().strftime("%Y-%m-%d")


def _season_now() -> str:
    m = _china_now().month
    if m in (3, 4, 5):
        return "春"
    if m in (6, 7, 8):
        return "夏"
    if m in (9, 10, 11):
        return "秋"
    return "冬"


def _weather_now() -> str:
    """用免费 wttr.in 拉当前天气（无需 key）；失败就返回空串由模型按季节兜底。"""
    try:
        req = urllib.request.Request(
            "https://wttr.in/?format=j1",
            headers={"User-Agent": "Mozilla/5.0"},
        )
        with urllib.request.urlopen(req, timeout=6) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        cc = data["current_condition"][0]
        desc = cc["weatherDesc"][0]["value"]
        temp = cc.get("temp_C", "—")
        return f"{desc} {temp}°C"
    except Exception:  # noqa: BLE001
        return ""


@app.post("/api/daily")
def api_daily(req: DailyRequest):
    """每日推荐（AI 搭配建议）：
    输入：季节/天气(服务端取) + 口味账本画像 + 忌口/时间
    输出：{日期, 季节, 天气, 搭配说明, 推荐:[{餐次,菜名,适合原因,做法思路,用时分钟}]}
    """
    today = _today_str()
    context = {
        "当前日期": today,          # 服务器按北京/本地时间确定，模型不得自行推算
        "季节": _season_now(),
        "天气": _weather_now() or "（无天气数据，按季节推荐）",
        "口味偏好": req.taste or None,
        "常做食材": req.topIngredients or [],
        "常做菜": req.topDishes or [],
        "忌口": req.avoids or [],
        "可用分钟": req.maxTime,
        "账本是否有记录": req.hasRecord,
        "节日主题": req.festival or "",
        "节令食物参考": _FESTIVAL_FOODS.get(req.festival, []),
        "count": max(1, min(req.count, 6)),
    }
    plan = daily_plan(context)
    plan["日期"] = today           # 用北京时间覆盖模型输出，避免模型给错日期
    plan["季节"] = context["季节"]
    plan.setdefault("天气", context["天气"])
    plan["节日"] = req.festival or ""
    plan["类型"] = "AI搭配建议（做法请以检索到的真实网页为准）"
    return plan


# ---- 让后端顺带托管前端页面（必须放在所有接口后面）----
# 效果：后端一启动，浏览器访问 http://IP:8000/ 就是网页本身。
# 这样部署/给别人演示时，对方只需输一个网址，不用另开文件、也不用管 CORS。
FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
if FRONTEND_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
