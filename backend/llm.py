"""
大模型调用与结果解析 —— 由【后端同学】维护
职责：真正去调 LLM API、处理超时/报错、把模型的文字回复解析成干净 JSON。
前端和 Prompt 同学都不需要关心这里。

⚠️ 使用说明（2026.9.3 更新）：
本模块当前保留三个职责：
1) recommend() / supplement() —— 因“防幻觉（只检索不生成）”已停用，main.py 不再调用；
2) daily_plan() —— 【每日菜谱推荐】：搭配建议型生成，输出标注 AI 建议，前端附真实做法入口；
3) clean_titles() —— 【搜索标题清洗】：把网页检索回的菜名类标题批量交给大模型提取干净菜名
   （正则只作离线兜底；本函数失败时 main.py 自动回落正则清洗）。
"""
import json
import os
import re
from pathlib import Path

from dotenv import load_dotenv
from fastapi import HTTPException
from openai import OpenAI

from prompt import (
    AVOID_VOCAB,
    COOKWARE_VOCAB,
    DIFFICULTY_VOCAB,
    FLAVOR_KEYS,
    build_clean_titles_messages,
    build_daily_messages,
    build_messages,
    build_supplement_messages,
)

# 关键：必须在读环境变量之前加载 .env（main.py 也可能已加载过，重复加载无副作用）
load_dotenv(Path(__file__).resolve().parent / ".env")

MODEL = os.getenv("LLM_MODEL", "deepseek-chat")
BASE_URL = os.getenv("LLM_BASE_URL", "https://api.deepseek.com")
API_KEY = os.getenv("LLM_API_KEY", "")


def _extract_json(text: str) -> dict:
    """模型有时会夹带文字或 ```json 代码块，这里只抠出 JSON 部分。"""
    text = text.strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if fence:
        text = fence.group(1)
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end != -1:
        text = text[start:end + 1]
    return json.loads(text)


def recommend(user: dict) -> dict:
    """主入口：传入用户条件字典，返回 {推荐: [...]}。"""
    # MOCK=1 时返回写死的示例，方便前端/联调在没有 key 的情况下先干活
    if os.getenv("MOCK") == "1":
        return MOCK_RESPONSE

    if not API_KEY:
        raise HTTPException(
            status_code=500,
            detail="还没配置 LLM_API_KEY，请在 .env 里填入，或临时设 MOCK=1",
        )

    client = OpenAI(api_key=API_KEY, base_url=BASE_URL, timeout=60)

    # 最多试两次：第一次失败（网络抖动/返回格式不对）就重试一次
    last_error = None
    for _ in range(2):
        try:
            resp = client.chat.completions.create(
                model=MODEL,
                messages=build_messages(user),
                temperature=0.7,
                # 要求模型输出 JSON 对象（各家大模型 API 基本都支持）
                response_format={"type": "json_object"},
            )
            content = resp.choices[0].message.content
            data = _extract_json(content)
            # 归一化：万一模型直接给的是数组，也包装成 {推荐: [...]}
            if isinstance(data, list):
                data = {"推荐": data}
            return data
        except Exception as e:  # noqa: BLE001 —— 无论哪种错误都先重试一次
            last_error = e

    raise HTTPException(status_code=502, detail=f"大模型调用失败：{last_error}")


def _clamp_int(value, lo: int, hi: int, default: int) -> int:
    try:
        return max(lo, min(hi, int(value)))
    except (TypeError, ValueError):
        return default


def _to_frontend_recipe(item: dict, idx: int) -> dict | None:
    """把模型输出的中文键菜谱，翻译成前端 app.js 认识的结构；不合格的丢弃。"""
    try:
        ingredients = [str(i).strip() for i in (item.get("食材") or []) if str(i).strip()]
        steps = [str(s).strip() for s in (item.get("做法步骤") or item.get("步骤") or []) if str(s).strip()]
        if not item.get("菜名") or not ingredients or not steps:
            return None

        flavor = {}
        raw_flavor = item.get("口味") or {}
        for k in FLAVOR_KEYS:
            flavor[k] = _clamp_int(raw_flavor.get(k), 0, 10, 5)

        avoid = [a for a in (item.get("忌口标签") or []) if a in AVOID_VOCAB]
        cookware = item.get("厨具")
        if cookware not in COOKWARE_VOCAB:
            cookware = "炒锅"
        difficulty = item.get("难度")
        if difficulty not in DIFFICULTY_VOCAB:
            difficulty = "简单"

        name = str(item["菜名"]).strip()
        return {
            # 负数 id：前端用 id 做折叠定位，负号保证和内置菜谱不冲突
            "id": -(idx + 1),
            "name": name,
            "desc": f"AI 现场生成的健康家常菜，主料：{'、'.join(ingredients)}。",
            "time": _clamp_int(item.get("预计分钟"), 5, 180, 30),
            "difficulty": difficulty,
            "cookware": cookware,
            "ingredients": ingredients,
            "seasoning": str(item.get("调料") or "盐、生抽适量"),
            "flavor": flavor,
            "avoid": avoid,
            "steps": steps[:8],
            "video": False,
        }
    except Exception:  # noqa: BLE001 —— 单条数据坏了就丢弃，不影响整体
        return None


def supplement(conditions: dict, exclude_names: list[str]) -> dict:
    """AI 补菜：本地库匹配太少时调用。返回 {推荐: [前端schema菜谱...]}。"""
    if os.getenv("MOCK") == "1":
        item = _to_frontend_recipe(MOCK_SUPPLEMENT_ITEM, 0)
        return {"推荐": [item] if item else []}

    if not API_KEY:
        raise HTTPException(
            status_code=500,
            detail="还没配置 LLM_API_KEY，请在 .env 里填入，或临时设 MOCK=1",
        )

    client = OpenAI(api_key=API_KEY, base_url=BASE_URL, timeout=60)
    last_error = None
    for _ in range(2):
        try:
            resp = client.chat.completions.create(
                model=MODEL,
                messages=build_supplement_messages(conditions, exclude_names),
                temperature=0.85,  # 补菜需要一定发散性
                response_format={"type": "json_object"},
            )
            content = resp.choices[0].message.content
            data = _extract_json(content)
            raw_list = data.get("推荐") if isinstance(data, dict) else data
            if not isinstance(raw_list, list):
                raise ValueError("模型没有返回推荐数组")

            items = []
            for i, item in enumerate(raw_list):
                converted = _to_frontend_recipe(item, i)
                if converted:
                    items.append(converted)
            if not items:
                raise ValueError("模型返回的菜谱全部不合格")
            return {"推荐": items}
        except Exception as e:  # noqa: BLE001
            last_error = e

    raise HTTPException(status_code=502, detail=f"AI 补菜失败：{last_error}")


def daily_plan(context: dict) -> dict:
    """每日菜谱推荐：结合季节/天气 + 用户口味账本，生成搭配建议菜单。
    属于“搭配建议型生成”，非菜谱库数据；返回结构见 prompt.py 的 DAILY_SYSTEM。"""
    if os.getenv("MOCK") == "1":
        return MOCK_DAILY_RESPONSE

    if not API_KEY:
        raise HTTPException(
            status_code=500,
            detail="还没配置 LLM_API_KEY，请在 .env 里填入，或临时设 MOCK=1",
        )

    client = OpenAI(api_key=API_KEY, base_url=BASE_URL, timeout=60)
    last_error = None
    for _ in range(2):
        try:
            resp = client.chat.completions.create(
                model=MODEL,
                messages=build_daily_messages(context, context.get("count", 3)),
                temperature=0.75,
                response_format={"type": "json_object"},
            )
            content = resp.choices[0].message.content
            data = _extract_json(content)
            if not isinstance(data, dict) or not isinstance(data.get("推荐"), list):
                raise ValueError("模型返回的每日菜单格式不对")
            return data
        except Exception as e:  # noqa: BLE001
            last_error = e

    raise HTTPException(status_code=502, detail=f"每日菜单生成失败：{last_error}")


def clean_titles(items: list[dict]) -> dict[str, dict]:
    """批量把搜索结果（标题+摘要）交给大模型清洗，返回 {原标题: {"name":…, "summary":…}}。

    - items: [{"标题": str, "摘要": str}]，一次最多分批 8 条；
    - 简介(摘要垃圾时)可为空字符串，由调用方回落兜底文案；
    - 没配 key / MOCK=1 / 模型报错 → 返回空 dict（调用方自动用正则+兜底文案）。
    """
    if not items:
        return {}
    if os.getenv("MOCK") == "1" or not API_KEY:
        return {}

    client = OpenAI(api_key=API_KEY, base_url=BASE_URL, timeout=60)
    clean_map: dict[str, dict] = {}

    def _valid_name(name) -> str:
        n = str(name or "").strip().strip("【】").strip()
        if len(n) < 2 or len(n) > 24 or n in {"随便", "大全", "食谱", "菜谱"}:
            return ""
        if re.search(r"(_|｜|怎么办|怎么做好|做法|步骤|大全|菜谱)$", n):
            return ""
        return n

    def _valid_summary(s) -> str:
        txt = str(s or "").strip().replace("\n", " ")
        if len(txt) < 6 or len(txt) > 120:
            return ""
        return txt[:120]

    for i in range(0, len(items), 8):
        chunk = items[i:i + 8]
        for _ in range(2):
            try:
                resp = client.chat.completions.create(
                    model=MODEL,
                    messages=build_clean_titles_messages(chunk),
                    temperature=0.1,
                    response_format={"type": "json_object"},
                )
                data = _extract_json(resp.choices[0].message.content)
                for row in (data.get("结果") or data.get("items") or []):
                    if not isinstance(row, dict):
                        continue
                    raw = str(row.get("原标题") or row.get("title") or "").strip()
                    if raw not in {str(c.get("标题", "")).strip() for c in chunk}:
                        continue
                    name = _valid_name(row.get("菜名") or row.get("name") or "")
                    summary = _valid_summary(row.get("简介") or row.get("summary") or "")
                    if name:
                        clean_map[raw] = {"name": name, "summary": summary}
                break  # 本批成功
            except Exception:  # noqa: BLE001 —— 失败静默，调用方回落正则
                pass
    return clean_map


# ---- MOCK 示例数据：和真实模型返回的格式完全一致 ----
MOCK_RESPONSE = {
    "推荐": [
        {
            "菜名": "青椒炒五花肉（示例数据）",
            "预计分钟": 15,
            "评分": {"用时": 9, "口味": 8, "复杂度": 8},
            "理由": "示例数据：用你现有的五花肉和青椒就能做，只需油、盐、生抽，20分钟内轻松完成。",
            "替代建议": "没有青椒可用蒜苗或洋葱代替",
            "步骤": [
                "五花肉切薄片，青椒去籽切块",
                "热锅少油，下肉片中火煸炒至微微出油",
                "下青椒大火翻炒约2分钟",
                "加生抽、盐调味，炒匀出锅",
            ],
        },
        {
            "菜名": "蒜蓉油麦菜（示例数据）",
            "预计分钟": 10,
            "评分": {"用时": 10, "口味": 7, "复杂度": 9},
            "理由": "示例数据：十分钟快手素菜，解腻清淡，和肉菜正好搭配。",
            "替代建议": "油麦菜可用生菜或菠菜代替",
            "步骤": [
                "油麦菜洗净切段，蒜拍碎切末",
                "热油爆香蒜末",
                "下油麦菜大火快炒至断生",
                "加盐调味出锅",
            ],
        },
    ]
}

# AI 补菜的 MOCK 数据：用"模型输出的中文键格式"写，好顺便验证翻译逻辑
MOCK_SUPPLEMENT_ITEM = {
    "菜名": "虾仁西兰花（MOCK 补菜示例）",
    "预计分钟": 18,
    "难度": "简单",
    "厨具": "炒锅",
    "食材": ["虾仁", "西兰花", "蒜"],
    "调料": "生抽 10ml、盐 2g、橄榄油 5ml",
    "口味": {"salty": 4, "sweet": 0, "spicy": 1, "sour": 0, "umami": 7},
    "忌口标签": [],
    "做法步骤": [
        "西兰花切小朵焯水 90 秒，虾仁开背去虾线",
        "热锅少油爆香蒜末，下虾仁炒至变红",
        "倒入西兰花大火翻炒 1 分钟",
        "加生抽与盐调味出锅",
    ],
}

# 每日推荐的 MOCK：结构必须与 DAILY_SYSTEM 里要求的 JSON 完全一致
MOCK_DAILY_RESPONSE = {
    "日期": "2026-09-03",
    "季节": "秋",
    "天气": "多云 26°C（示例）",
    "搭配说明": "秋季润燥为主，一汤一荤一素，配上周五晚上的快手节奏。",
    "推荐": [
        {
            "餐次": "晚餐",
            "菜名": "冬瓜薏米排骨汤",
            "适合原因": "秋燥明显，冬瓜薏米清热利湿，排骨补充蛋白质，暖胃又不过火。",
            "做法思路": "排骨焯水后与冬瓜块、薏米同炖40分钟，出锅前调味，少油清淡。",
            "用时分钟": 45,
        },
        {
            "餐次": "晚餐",
            "菜名": "蒜蓉蒸丝瓜",
            "适合原因": "应季丝瓜清甜，蒸制保留水分，润燥且几乎不用油。",
            "做法思路": "丝瓜切段铺盘，铺蒜蓉上锅蒸8分钟，淋少许生抽即可。",
            "用时分钟": 15,
        },
        {
            "餐次": "晚餐",
            "菜名": "香菇滑鸡",
            "适合原因": "符合你常做鸡肉的口味习惯，香菇提鲜，下饭又不太咸。",
            "做法思路": "鸡腿肉切块腌15分钟，与香菇同炒至熟，勾薄芡出锅。",
            "用时分钟": 25,
        },
    ],
}
