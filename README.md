# 健康菜谱推荐系统

> 《综合项目实践》四人小组作品：根据你手边的食材、厨具、可用时间与口味偏好，
> 从**本地菜谱库 + 全网真实菜谱**里检索推荐；另带"菜谱账本"（收藏/做菜记账）与
> AI 每日菜单（结合季节/天气/口味/传统节日）。

架构：`浏览器页面 → FastAPI 后端 → 菜谱库(本地JSON) / Tavily网页检索 / Agnes大模型`

---

## 功能一览

| 模块 | 说明 |
|---|---|
| 本地检索推荐 | 152 道内置大菜谱库（`backend/data/recipes.json`，可再扩），按 食材/厨具/时间/口味/忌口 打分 |
| 分类 + 分页 | 结果按 汤羹/蒸炖/烤炸/凉拌/主食/荤菜/素菜蛋豆 分类；每页 8 张 |
| AI 再找几道（检索，非生成） | 本地不足时：先放宽时间 ≤15 分钟从库里补；再不够用 **Tavily 搜全网真实菜谱**（优先下厨房），每条带来源链接可溯源 |
| AI 标题清洗 + 简介 | 网页标题交给 **Agnes** 提取干净菜名并概括做法简介；正则只做离线兜底；"评分/人做过"类垃圾正文自动丢弃 |
| 加入菜谱库 | 全网检索到的好菜一键收录进本地 `recipes.json`（持久化，之后本地可搜到） |
| 菜谱账本 | 收藏 + 烹饪记账（每道菜做过几次、最近日期、占比条），两列便签+分页，存浏览器 localStorage |
| 每日菜谱推荐 | Agnes 结合 季节/实时天气/账本口味画像 生成一餐搭配（标注"AI 建议"，做法可跳下厨房/B站核验） |
| 节日特供 | 春节/元宵/端午/中秋/冬至/腊八… 选节日后生成应景菜单（内置节令食物常识表） |
| 界面 | 悬浮按钮展开"账本 / 每日菜单"；深色木桌 + 记事本/纸胶带便签主题；离线 vendor 素材 |

## 防幻觉设计（重要原则）

- **事实信息（菜名/食材/步骤）→ 只检索**：补菜绝不"现场编菜谱"；库外结果必须是网页真实条目并附来源 URL。
- **搭配建议（每日菜单/节日菜单）→ 允许生成**，但输出标注"AI 建议"，前端为每道菜提供真实做法检索入口。
- 清洗/简介等"理解型"任务交给大模型；输出有长度/脏词校验，失败自动回落。

---

## 目录结构

```
recipe/
├─ backend/                      # FastAPI 后端
│  ├─ main.py                    # HTTP 接口、检索打分、Tavily、收录、每日/节日
│  ├─ llm.py                     # Agnes 调用：daily_plan / clean_titles（含 MOCK）
│  ├─ prompt.py                  # 提示词：每日推荐、节日特供、标题清洗（补菜生成已废弃留档）
│  ├─ data/recipes.json          # 本地菜谱库（当前 152 道，可跑脚本扩充/收录追加）
│  ├─ .env.example               # 环境变量模板（复制为 .env 填 key）
│  ├─ requirements.txt
│  └─ start.bat                  # Windows 一键启动（自动建 .venv 装依赖）
├─ frontend/                     # 前端（由后端静态托管）
│  ├─ index.html / app.js / style.css
│  └─ vendor/                    # 离线化素材（bootstrap、fontawesome，无需外网）
└─ tools/
   └─ generate_recipes.py        # 批量扩充菜谱库脚本（每轮存盘/去重/校验）
```

## 启动（Windows，一行）

```bat
cd backend
start.bat
```

等价手动步骤：装 Python 3.10+ → `python -m venv .venv` →
`pip install fastapi "uvicorn[standard]" openai python-dotenv` →
`uvicorn main:app --reload`

然后打开 **http://127.0.0.1:8000/**（完整网页）；接口文档 **http://127.0.0.1:8000/docs**。

### 环境变量 `backend/.env`

复制 `backend/.env.example` 为 `.env`：

| 变量 | 用途 | 是否必须 |
|---|---|---|
| `LLM_API_KEY` | Agnes 大模型：每日菜单生成、网页标题清洗/简介 | 推荐开启（否则每日/清洗走不了） |
| `LLM_BASE_URL` | `https://apihub.agnes-ai.com/v1` | 开 LLM 时必须 |
| `LLM_MODEL` | `agnes-2.5-flash`（可换 `agnes-2.5-pro`） | 开 LLM 时必须 |
| `MOCK` | `1` 时所有 LLM 调用返回示例，不联网 | 可选 |
| `TAVILY_API_KEY` | AI 补菜的"全网真实菜谱"检索 | 可选（不配则只做库内补充） |

> ⚠️ `.env` / `api.txt` 已被 `.gitignore` 忽略，**不要提交**，也不要发到公开渠道。

## 接口

| 接口 | 说明 |
|---|---|
| `GET /health` | 健康检查 |
| `GET /api/recipes` | 返回整个本地菜谱库 |
| `POST /api/recipes/add` | 把全网检索到的好菜收录进本地库（校验来源链接 + 字段白名单 + 防重复） |
| `POST /api/supplement` | AI 补菜：库内放宽时间 ≤15min 补 + 不足时 Tavily 全网检索（Agnes 清洗名/简介），返回 `{推荐, 库内补, 库外补, note}` |
| `POST /api/daily` | 每日/节日菜单：季节+天气+口味画像+节日 → 返回 `{搭配说明, 推荐:[{餐次,菜名,适合原因,做法思路,用时分钟}]}` |
| `POST /api/recommend` | 通用检索推荐（历史接口，新前端不再调用） |

## 扩充菜谱库

```bash
python tools/generate_recipes.py            # 默认扩到目标规模（需要真实 LLM key）
python tools/generate_recipes.py --target 200
python tools/generate_recipes.py --rounds-limit 5   # 先试水
```

脚本产出实时写 `backend/data/recipes.json`，后端读文件无需重启。
另外，页面上对"AI 全网结果"点 **加入菜谱库** 也会持久化进该文件。

## 没 Key 怎么演示

- `MOCK=1`：每日菜单等返回写死示例；
- 不配 Tavily：AI 补菜只做库内补充并提示如何开启；
- 前端 + 内置 26 道菜：后端不开也能打开页面（少联网功能）。

## Git 协作须知

- 提交前确认 `.env`、`api.txt`、备份目录都在 `.gitignore` 里（已配好）。
- 每位成员先设 git 身份（邮箱用 GitHub 绑定的那个），否则贡献者统计不准：
  ```bash
  git config user.name "你的GitHub昵称"
  git config user.email "你的GitHub绑定邮箱"
  ```
- 分工建议（文件边界互不冲突）：

| 人 | 文件 | 事项 |
|---|---|---|
| 数据 | `tools/generate_recipes.py`、`backend/data/recipes.json` | 扩库、收录数据质量 |
| 后端 | `backend/main.py`、`backend/llm.py` | 接口、检索、清洗、错误处理 |
| Prompt | `backend/prompt.py` | 每日/节日/清洗提示词打磨 |
| 前端 | `frontend/index.html`、`app.js`、`style.css` | UI 交互、卡片/账本展示 |

## 三种运行模式

- 各自开发：`uvicorn main:app --reload` → 各自访问 `http://127.0.0.1:8000/`
- 局域网联调：`uvicorn main:app --host 0.0.0.0 --reload`，队友访问
  `http://你的局域网IP:8000/`（防火墙放行 8000）
- 公网演示：cpolar/ngrok 临时穿透；或云服务器长期部署

代码完全一样，差别只是跑在哪台机器、别人从哪访问。
