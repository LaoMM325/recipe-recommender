"""
批量生成大菜谱库 —— 由【后端/数据同学】维护

把本地只有 26 道的菜谱库扩到 100~200 道：
循环让大模型一次生成几道菜，自动校验字段合法性、按菜名去重，
每轮结束立刻存盘（中断也不丢已生成的部分）。

用法（先按 README 配好 backend/.env 的 LLM_API_KEY）：
    python tools/generate_recipes.py                # 默认扩到 150 道
    python tools/generate_recipes.py --target 200    # 扩到 200 道
    python tools/generate_recipes.py --rounds-limit 10   # 最多只跑 10 轮（试水）

产出：backend/data/recipes.json（字段与前端 app.js 的 RECIPES 完全一致）
"""
import argparse
import json
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"
DATA_FILE = BACKEND / "data" / "recipes.json"

# 让脚本能 import backend 里的词表常量（prompt.py 无外部依赖，安全）
sys.path.insert(0, str(BACKEND))
from prompt import (  # noqa: E402
    AVOID_VOCAB,
    COOKWARE_VOCAB,
    DIFFICULTY_VOCAB,
    FLAVOR_KEYS,
    INGREDIENT_VOCAB,
)

try:  # 读取 backend/.env
    from dotenv import load_dotenv

    load_dotenv(BACKEND / ".env")
except Exception:  # noqa: BLE001 —— dotenv 不在也能跑，只是要从环境变量给 key
    pass

import os  # noqa: E402

from openai import OpenAI  # noqa: E402

MODEL = os.getenv("LLM_MODEL", "deepseek-chat")
BASE_URL = os.getenv("LLM_BASE_URL", "https://api.deepseek.com")
API_KEY = os.getenv("LLM_API_KEY", "")

# 前端 app.js 里已内置的 26 道菜名：生成时避开，避免前端合并后出现重名
BUILTIN_NAMES = {
    "番茄土豆片", "清炒西兰花", "爽口凉拌黄瓜", "香菇滑鸡", "宫保鸡丁", "清蒸鲈鱼",
    "蒜蓉粉丝虾仁", "冬瓜排骨汤", "杏鲍菇炒肉片", "番茄牛腩", "素三鲜", "红薯燕麦粥",
    "空气炸锅香煎鸡胸", "烤三文鱼时蔬", "微波南瓜块", "冬瓜蛤蜊汤", "青椒肉丝",
    "玉米排骨汤", "番茄豆腐汤", "虾仁蒸蛋", "核桃拌菠菜", "柠檬蜂蜜烤鸡腿",
    "香菇烧豆腐", "白菜豆腐汤", "香煎嫩豆腐", "麻婆豆腐",
}

# 轮换的"重点食材"：保证库里每样常见食材都有菜可配，搜啥都不至于空
FOCUS_INGREDIENTS = [
    "鸡胸肉", "鸡腿肉", "猪里脊", "牛腩", "排骨", "鸡蛋", "豆腐", "虾仁", "鲈鱼",
    "三文鱼", "蛤蜊", "香菇", "西兰花", "番茄", "土豆", "白菜", "冬瓜", "南瓜",
    "菠菜", "黄瓜", "红薯", "燕麦", "胡萝卜", "青椒", "木耳", "金针菇",
]

COOKING_MIX = "做法尽量分散在快炒、清蒸、炖煮、凉拌、煎烤、汤羹、粥饭等不同类型，避免全是同一做法。"

GENERATE_SYSTEM = f"""你是中式健康家常菜谱作者。请创作真实、可行的健康家常菜。

硬性要求：
1. 每道菜【食材】只使用以下词表中的名称（2~4 种，可含葱姜蒜等调味蔬菜）：
{"、".join(INGREDIENT_VOCAB)}
2. 【厨具】只能取以下之一：{"、".join(COOKWARE_VOCAB)}
3. 【忌口标签】只能取以下组合（没有则为空数组）：{"、".join(AVOID_VOCAB)}
4. 【难度】只能取：{"、".join(DIFFICULTY_VOCAB)}
5. 【口味评分】口味对象键为 {"、".join(FLAVOR_KEYS)}（咸/甜/辣/酸/鲜），每项 0~10 整数。
6. 【做法步骤】3~6 步，每步一句话，具体到火候和用量。
7. 只输出合法 JSON，不要任何多余文字。结构：
{{
  "推荐": [
    {{
      "菜名": "菜的名字",
      "预计分钟": 20,
      "难度": "简单",
      "厨具": "炒锅",
      "食材": ["鸡胸肉", "西兰花"],
      "调料": "生抽 10ml、盐 2g、蒜末少许",
      "口味": {{"salty": 4, "sweet": 0, "spicy": 2, "sour": 0, "umami": 5}},
      "忌口标签": [],
      "做法步骤": ["第1步", "第2步", "第3步"]
    }}
  ]
}}"""


def extract_json_array(text: str) -> list:
    text = text.strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if fence:
        text = fence.group(1)
    start, end = text.find("["), text.rfind("]")
    if start != -1 and end != -1 and end > start:
        text = text[start:end + 1]
        data = json.loads(text)
        return data if isinstance(data, list) else []
    # 兜底：模型包了一层 {"推荐": [...]}
    obj_start, obj_end = text.find("{"), text.rfind("}")
    if obj_start != -1 and obj_end != -1:
        data = json.loads(text[obj_start:obj_end + 1])
        if isinstance(data, dict) and isinstance(data.get("推荐"), list):
            return data["推荐"]
    return []


def validate_and_translate(item: dict) -> dict | None:
    """校验并把模型的中文键翻译成前端 schema；不合格返回 None。"""
    try:
        name = str(item.get("菜名") or "").strip()
        ingredients = [str(i).strip() for i in (item.get("食材") or []) if str(i).strip()]
        steps = [str(s).strip() for s in (item.get("做法步骤") or []) if str(s).strip()]
        # 食材必须在词表内、步骤必须够、名字必须非空
        if not name or len(ingredients) < 2 or any(i not in INGREDIENT_VOCAB for i in ingredients):
            return None
        if not (2 <= len(steps) <= 8):
            return None

        def clamp_int(v, lo, hi, default):
            try:
                return max(lo, min(hi, int(v)))
            except (TypeError, ValueError):
                return default

        flavor = {}
        raw = item.get("口味") or {}
        for k in FLAVOR_KEYS:
            flavor[k] = clamp_int(raw.get(k), 0, 10, 5)

        cookware = item.get("厨具")
        if cookware not in COOKWARE_VOCAB:
            cookware = "炒锅"
        difficulty = item.get("难度")
        if difficulty not in DIFFICULTY_VOCAB:
            difficulty = "简单"

        desc = str(item.get("简介") or "").strip()
        if not desc:
            desc = f"{'、'.join(ingredients)}做的健康家常菜，用时适中，做法清晰。"
        return {
            "id": 0,  # 真实 id 由主循环按序分配
            "name": name,
            "desc": desc,
            "time": clamp_int(item.get("预计分钟"), 5, 120, 30),
            "difficulty": difficulty,
            "cookware": cookware,
            "ingredients": ingredients,
            "seasoning": str(item.get("调料") or "盐、生抽适量"),
            "flavor": flavor,
            "avoid": [a for a in (item.get("忌口标签") or []) if a in AVOID_VOCAB],
            "steps": steps,
            "video": bool(item.get("video", False)),
        }
    except Exception:  # noqa: BLE001
        return None


def main():
    parser = argparse.ArgumentParser(description="批量生成大菜谱库")
    parser.add_argument("--target", type=int, default=150, help="目标菜谱数（默认 150）")
    parser.add_argument("--per-call", type=int, default=6, help="每轮让模型生成几道（默认 6）")
    parser.add_argument("--rounds-limit", type=int, default=60, help="最多轮数（默认 60）")
    args = parser.parse_args()

    if not API_KEY:
        print("❌ 没找到 LLM_API_KEY：请先复制 backend/.env.example 为 backend/.env 并填入 key")
        sys.exit(1)

    client = OpenAI(api_key=API_KEY, base_url=BASE_URL, timeout=90)
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)

    # 已有库 + 内置 26 道的名字都加入排除集，避免重复
    existing = []
    if DATA_FILE.exists():
        try:
            existing = json.loads(DATA_FILE.read_text(encoding="utf-8"))
            if not isinstance(existing, list):
                existing = []
        except json.JSONDecodeError:
            existing = []
    known_names = set(BUILTIN_NAMES)
    known_names.update(r.get("name", "") for r in existing)

    total = len(existing)
    empty_streak = 0
    next_id = max([r.get("id", 0) for r in existing] or [0]) + 1
    print(f"📚 当前库 {total} 道，目标 {args.target} 道，开始生成……")

    for round_no in range(1, args.rounds_limit + 1):
        if total >= args.target:
            break
        focus = FOCUS_INGREDIENTS[(round_no - 1) % len(FOCUS_INGREDIENTS)]
        user_prompt = (
            f"本轮请生成 {args.per_call} 道彼此不同的健康家常菜。\n"
            f"重点：至少 {max(2, args.per_call // 2)} 道用到食材「{focus}」。\n"
            f"{COOKING_MIX}\n"
            f"菜名不要与这些重复：{'、'.join(sorted(list(known_names))[:60])}。"
        )

        try:
            resp = client.chat.completions.create(
                model=MODEL,
                messages=[
                    {"role": "system", "content": GENERATE_SYSTEM},
                    {"role": "user", "content": user_prompt},
                ],
                temperature=0.9,
                response_format={"type": "json_object"},
            )
            raw_list = extract_json_array(resp.choices[0].message.content)
        except Exception as e:  # noqa: BLE001
            print(f"  ⚠️ 第 {round_no} 轮调用失败：{e}，跳过")
            empty_streak += 1
            if empty_streak >= 3:
                print("连续 3 轮失败，中止。已生成的库保留。")
                break
            continue

        added = 0
        for item in raw_list:
            r = validate_and_translate(item)
            if r and r["name"] not in known_names:
                r["id"] = next_id
                next_id += 1
                known_names.add(r["name"])
                existing.append(r)
                added += 1

        total = len(existing)
        # 每轮结束就写盘：中断不丢进度
        DATA_FILE.write_text(
            json.dumps(existing, ensure_ascii=False, indent=1), encoding="utf-8"
        )
        empty_streak = 0 if added else empty_streak + 1
        print(f"  ✅ 第 {round_no} 轮：模型给了 {len(raw_list)} 道，通过并新增 {added} 道（当前共 {total}）")

        if total >= args.target:
            break
        time.sleep(1)

    print(f"\n🎉 完成：backend/data/recipes.json 现有 {total} 道菜谱。")
    if total < args.target:
        print(f"（未达到 {args.target}，可再跑一次：脚本会自动续接去重）")


if __name__ == "__main__":
    main()
