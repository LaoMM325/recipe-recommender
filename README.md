# 健康菜谱推荐系统

架构：`浏览器页面 → FastAPI 后端 → 大模型 API`。页面从后端拉**大菜谱库**做本地匹配推荐；
本地库匹配太少时点"让 AI 再补几道"，后端让大模型**现场生成**补充菜谱。

```
recipe/
├─ backend/                      # 后端（FastAPI + Python）
│  ├─ main.py                    # 【后端】HTTP 接口 + CORS + 静态托管前端
│  ├─ llm.py                     # 【后端】调大模型 API + 解析/字段翻译（含 MOCK）
│  ├─ prompt.py                  # 【Prompt】两套提示词：旧推荐 + AI补菜（含食材词表约束）
│  ├─ data/recipes.json          # 【数据】大菜谱库（初始为空，跑生成脚本后填充）
│  ├─ requirements.txt
│  └─ .env.example               # 复制为 .env 填 key
├─ frontend/                     # 【前端】正式 UI（健康菜谱推荐系统）
│  ├─ index.html
│  ├─ app.js                     # 拉大库合并去重 + 筛选评分 + AI 补菜
│  └─ style.css
└─ tools/
   └─ generate_recipes.py        # 【数据】批量生成大菜谱库的脚本
```

## 启动步骤（Windows）

> 需要 **Python 3.10+**（代码用了 `int | None` 语法）。

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env      # 编辑 .env 填入 LLM_API_KEY（没有 key 就设 MOCK=1）
uvicorn main:app --reload
```

启动后访问 **http://127.0.0.1:8000/** 即是完整网页。

## 把菜谱库扩到 100~200 道（解决"搜出来菜太少"）

页面内置了 26 道示例菜。要更多，跑一次批量生成脚本（自动校验 + 去重 + 每轮存盘）：

```bash
python tools/generate_recipes.py            # 默认扩到 150 道（需要真实 API key）
python tools/generate_recipes.py --target 200
python tools/generate_recipes.py --rounds-limit 5   # 先跑 5 轮试水
```

跑完刷新页面，"共 X 道菜谱"就会变成 100+。
脚本产出写入 `backend/data/recipes.json`，后端 `/api/recipes` 实时读文件，**不用重启**。

## 三个后端接口

| 接口 | 作用 |
|---|---|
| `GET /api/recipes` | 返回整个大菜谱库（页面启动时拉取，与内置 26 道按菜名合并去重） |
| `POST /api/supplement` | AI 补菜：传当前筛选条件，返回 `{推荐:[前端schema菜谱]}` |
| `POST /api/recommend` | 早期通用推荐（旧示例在用，新页面不调用） |

AI 补菜请求示例（/docs 里也能在线调）：

```jsonc
POST /api/supplement
{
  "ingredients": ["鸡胸肉"], "cookware": ["炒锅"], "avoids": [],
  "flavors": {"salty": 5, "sweet": 5, "spicy": 5, "sour": 5, "umami": 5},
  "keywords": [], "maxTime": 20, "requestText": "",
  "count": 4, "excludeNames": ["宫保鸡丁"]
}
```

## 没 Key 也能联调

`backend/.env` 设 `MOCK=1`：AI 补菜返回写死的示例菜，扩库脚本需真实 key 才能跑。

## 自测入口

- 首页：http://127.0.0.1:8000/
- 接口文档（在线调试）：http://127.0.0.1:8000/docs
- 健康检查：http://127.0.0.1:8000/health

## 换别家大模型

只改 `backend/.env` 两行（几乎都兼容 OpenAI 接口）：

| 厂商 | LLM_BASE_URL | LLM_MODEL |
|---|---|---|
| Agnes（本项目现用，key 在 backend/.env） | https://apihub.agnes-ai.com/v1 | agnes-2.5-flash（质量更高可换 agnes-2.5-pro） |
| DeepSeek | https://api.deepseek.com | deepseek-chat |
| OpenAI | https://api.openai.com/v1 | gpt-4o-mini |
| 通义千问 | https://dashscope.aliyuncs.com/compatible-mode/v1 | qwen-plus |
| Kimi | https://api.moonshot.cn/v1 | moonshot-v1-8k |

## 四个人各自动哪些文件

| 人 | 动的文件 | 事项 |
|---|---|---|
| 数据 | `backend/data/recipes.json`、`tools/generate_recipes.py` | 跑脚本把库扩到 100+，保证每种食材都有菜 |
| 后端 | `backend/main.py`、`backend/llm.py` | 三个接口逻辑、报错处理、字段翻译 |
| Prompt | `backend/prompt.py` | 打磨 AI 补菜质量：别编出离谱菜、格式必须合法 |
| 前端 | `frontend/index.html`、`frontend/app.js` | 交互细节、补菜卡片展示 |
| 测试/集成 | 跑通自测入口 + 典型场景 | 回归测试、管演示 |

## 三种联网模式（网页后端需不需要"服务器"？）

网页后端程序跑在哪台电脑上，哪台电脑此刻就是服务器。

- **模式① 各自开发**：每人 `uvicorn main:app --reload`，访问自己电脑的
  `http://127.0.0.1:8000/`，互不干扰（日常开发用这个）。
- **模式② 局域网联调**：A 用 `uvicorn main:app --host 0.0.0.0 --reload`，
  队友访问 `http://A的局域网IP:8000/`（同 WiFi；打不开就放行 8000 端口：
  `netsh advfirewall firewall add rule name="recipe" dir=in action=allow protocol=TCP localport=8000`）。
- **模式③ 公网访问/演示**：cpolar/ngrok 穿透本机 8000 端口得到公网链接（临时演示，
  免费）；或租最便宜的云服务器部署（长期在线）。

三种模式代码完全一样，差别只是程序跑在哪、别人从哪访问。

## 部署注意
- 别把 `.env`（含 API Key）传到公开仓库
- 长期运行用 `uvicorn main:app --host 0.0.0.0 --port 8000` + systemd/nohup
