/* 健康菜谱推荐系统 —— 模拟数据与推荐逻辑 */

/* ================= 与本地后端对接（大菜谱库 + 库内补充检索） =================
   防幻觉：所有展示菜谱必须来自菜谱库；本文件不调用任何“生成菜谱”接口。 */

// 从后端打开(http://IP:8000/)时用相对路径；双击本地文件(file://)打开时指向本机后端
const API_BASE = (() => {
  try {
    return location.protocol === 'file:' ? 'http://127.0.0.1:8000' : '';
  } catch (e) {
    return 'http://127.0.0.1:8000';
  }
})();

let serverRecipes = null;   // 后端大菜谱库；拉取失败则保持 null，退回内置 26 道
let aiExtra = [];           // 补充检索结果：[{recipe, percent, reasons}]（只来自菜谱库，不经过模型生成）
let aiSeq = 0;              // 补充卡片唯一 id 计数器（负数，避免与内置冲突）
let lastSig = '';           // 筛选条件指纹：条件一变，补充结果自动清空

// ---- 分类分页状态 ----
const PAGE_SIZE = 8;        // 每页卡片数（宽屏一行 4 张 × 2 行 = 8）
let catExact = 'all';       // 精准区当前分类
let pageExact = 1;          // 精准区当前页
let catWeak = 'all';        // 弱相关区当前分类
let pageWeak = 1;           // 弱相关区当前页
let weakOpen = null;        // null=按默认(无精准时展开)；true/false=用户手动展开/收起
let selectedFestival = '';  // 节日特供：春节/端午/中秋…空=不启用
let favPage = 1;            // 账本·收藏分页
let cookPage = 1;           // 账本·烹饪记录分页
let addedLibNames = new Set(); // 已收录进本地菜谱库的全网菜名（前端缓存，启动时从后端同步）

const INGREDIENT_CATEGORIES = [
  {
    name: '主食',
    icon: 'fa-bread-slice',
    items: ['米饭', '面条', '玉米', '红薯', '土豆', '燕麦', '全麦面包'],
  },
  {
    name: '蔬菜',
    icon: 'fa-carrot',
    items: ['番茄', '黄瓜', '菠菜', '西兰花', '胡萝卜', '白菜', '洋葱', '青椒', '冬瓜', '南瓜'],
  },
  {
    name: '肉类',
    icon: 'fa-drumstick-bite',
    items: ['鸡胸肉', '鸡腿肉', '猪里脊', '牛腩', '排骨'],
  },
  {
    name: '水产',
    icon: 'fa-fish',
    items: ['鲈鱼', '虾仁', '三文鱼', '蛤蜊'],
  },
  {
    name: '菌菇',
    icon: 'fa-leaf',
    items: ['香菇', '金针菇', '杏鲍菇', '木耳', '平菇'],
  },
  {
    name: '蛋与豆制品',
    icon: 'fa-egg',
    items: ['鸡蛋', '豆腐', '豆干', '豆浆', '毛豆'],
  },
  {
    name: '调味蔬菜',
    icon: 'fa-seedling',
    items: ['葱', '姜', '蒜', '香菜', '小米椒'],
  },
  {
    name: '坚果干果',
    icon: 'fa-cookie',
    items: ['花生米', '核桃', '腰果', '芝麻', '红枣'],
  },
  {
    name: '时令水果',
    icon: 'fa-apple-whole',
    items: ['柠檬', '苹果', '香蕉', '牛油果', '蓝莓'],
  },
];

const COOKWARE = [
  { name: '炒锅', icon: 'fa-fire-burner' },
  { name: '平底锅', icon: 'fa-circle' },
  { name: '蒸锅', icon: 'fa-smog' },
  { name: '汤锅', icon: 'fa-mug-hot' },
  { name: '电饭煲', icon: 'fa-plug' },
  { name: '烤箱', icon: 'fa-temperature-high' },
  { name: '空气炸锅', icon: 'fa-fan' },
  { name: '微波炉', icon: 'fa-bolt' },
  { name: '破壁机', icon: 'fa-blender' },
];

const FLAVORS = [
  { key: 'salty', label: '咸', icon: 'fa-droplet' },
  { key: 'sweet', label: '甜', icon: 'fa-candy-cane' },
  { key: 'spicy', label: '辣', icon: 'fa-pepper-hot' },
  { key: 'sour', label: '酸', icon: 'fa-lemon' },
  { key: 'umami', label: '鲜', icon: 'fa-shrimp' },
];

const AVOID_OPTIONS = ['高盐', '高糖', '高碘', '高脂', '辛辣', '坚果过敏'];

const RECIPES = [
  {
    id: 1,
    name: '番茄土豆片',
    desc: '少油快炒的清淡家常菜，酸甜开胃，适合控油控盐人群。',
    time: 15,
    difficulty: '简单',
    cookware: '炒锅',
    ingredients: ['番茄', '土豆'],
    seasoning: '盐 2g、葱花少许、橄榄油 5ml',
    flavor: { salty: 3, sweet: 2, spicy: 0, sour: 3, umami: 4 },
    avoid: [],
    steps: [
      '土豆去皮切薄片，清水冲洗去淀粉，沥干备用。',
      '番茄顶部划十字，热水烫 30 秒后去皮切块。',
      '热锅倒入橄榄油，下土豆片中火翻炒 2 分钟至边缘微透明。',
      '加入番茄块翻炒出汁，加盐调味，撒葱花出锅。',
    ],
    video: true,
  },
  {
    id: 2,
    name: '清炒西兰花',
    desc: '保留脆嫩口感的低卡蔬菜料理，膳食纤维丰富。',
    time: 12,
    difficulty: '简单',
    cookware: '炒锅',
    ingredients: ['西兰花', '胡萝卜'],
    seasoning: '盐 2g、蒜末少许、橄榄油 5ml',
    flavor: { salty: 3, sweet: 1, spicy: 0, sour: 0, umami: 3 },
    avoid: [],
    steps: [
      '西兰花切小朵，淡盐水浸泡 5 分钟后洗净。',
      '胡萝卜切薄片，沸水焯 1 分钟。',
      '西兰花沸水焯 90 秒，捞出过凉水保持翠绿。',
      '热锅少油爆香蒜末，倒入蔬菜大火翻炒 1 分钟，加盐出锅。',
    ],
    video: false,
  },
  {
    id: 3,
    name: '爽口凉拌黄瓜',
    desc: '零油烟冷菜，低热量高水分，夏日消暑首选。',
    time: 10,
    difficulty: '简单',
    cookware: '汤锅',
    ingredients: ['黄瓜', '蒜'],
    seasoning: '生抽 5ml、香醋 8ml、香油 2 滴',
    flavor: { salty: 3, sweet: 1, spicy: 2, sour: 4, umami: 2 },
    avoid: [],
    steps: [
      '黄瓜洗净去头尾，用刀背拍裂后切成小段。',
      '加 2g 盐抓匀腌 5 分钟，倒掉析出的水分。',
      '加入蒜末、生抽、香醋、香油拌匀。',
      '冷藏 10 分钟后风味更佳。',
    ],
    video: true,
  },
  {
    id: 4,
    name: '香菇滑鸡',
    desc: '蒸制少油，鸡腿肉嫩滑，香菇提供天然鲜味。',
    time: 25,
    difficulty: '中等',
    cookware: '蒸锅',
    ingredients: ['鸡腿肉', '香菇'],
    seasoning: '生抽 10ml、姜丝、料酒 5ml、淀粉 3g',
    flavor: { salty: 5, sweet: 1, spicy: 0, sour: 0, umami: 7 },
    avoid: [],
    steps: [
      '鸡腿肉去骨切块，加生抽、料酒、淀粉抓匀腌 15 分钟。',
      '干香菇温水泡发切片，泡菇水留用。',
      '鸡肉与香菇、姜丝拌匀，淋 2 勺泡菇水。',
      '水开后上锅大火蒸 12 分钟，关火焖 2 分钟。',
    ],
    video: true,
  },
  {
    id: 5,
    name: '宫保鸡丁',
    desc: '经典川味名菜，酸甜微辣，下饭但含糖与坚果。',
    time: 20,
    difficulty: '中等',
    cookware: '炒锅',
    ingredients: ['鸡胸肉', '青椒', '花生米'],
    seasoning: '干辣椒、生抽、香醋、白糖 8g',
    flavor: { salty: 6, sweet: 4, spicy: 6, sour: 3, umami: 5 },
    avoid: ['辛辣', '坚果过敏', '高糖'],
    steps: [
      '鸡胸肉切 1.5cm 丁，加生抽、淀粉腌 10 分钟。',
      '青椒切小块，干辣椒剪段备用。',
      '调碗汁：生抽、香醋、白糖、淀粉、清水按 2:2:1:1:4 混合。',
      '大火滑炒鸡丁至变白盛出，爆香辣椒后回锅，倒入碗汁收汁，撒花生米。',
    ],
    video: true,
  },
  {
    id: 6,
    name: '清蒸鲈鱼',
    desc: '高蛋白低脂肪，蒸制最大程度保留营养。',
    time: 18,
    difficulty: '中等',
    cookware: '蒸锅',
    ingredients: ['鲈鱼', '洋葱'],
    seasoning: '蒸鱼豉油 15ml、姜片、葱丝、料酒 5ml',
    flavor: { salty: 4, sweet: 0, spicy: 0, sour: 0, umami: 8 },
    avoid: [],
    steps: [
      '鲈鱼处理干净，两侧各划三刀，抹料酒和姜片腌 10 分钟。',
      '盘底铺洋葱丝与葱段，鱼身下垫两根葱以便蒸汽流通。',
      '水开后大火蒸 8 分钟，关火虚蒸 2 分钟。',
      '倒掉盘中腥水，铺新鲜葱丝，淋热油后浇蒸鱼豉油。',
    ],
    video: true,
  },
  {
    id: 7,
    name: '蒜蓉粉丝虾仁',
    desc: '虾仁低脂高蛋白，蒸制无需额外油脂。',
    time: 20,
    difficulty: '简单',
    cookware: '蒸锅',
    ingredients: ['虾仁'],
    seasoning: '龙口粉丝 50g、蒜末 20g、蒸鱼豉油 10ml',
    flavor: { salty: 4, sweet: 1, spicy: 1, sour: 0, umami: 8 },
    avoid: ['高碘'],
    steps: [
      '粉丝温水泡软，铺入盘底。',
      '虾仁开背去虾线，摆在粉丝上。',
      '蒜末用 5ml 油小火炒香，加蒸鱼豉油拌匀，淋在虾仁上。',
      '大火蒸 6 分钟，撒葱花即可。',
    ],
    video: false,
  },
  {
    id: 8,
    name: '冬瓜排骨汤',
    desc: '慢炖清汤，冬瓜利水消肿，滋补不油腻。',
    time: 60,
    difficulty: '简单',
    cookware: '汤锅',
    ingredients: ['排骨', '冬瓜'],
    seasoning: '姜片 3 片、料酒 10ml、盐 3g、白胡椒粉少许',
    flavor: { salty: 4, sweet: 1, spicy: 0, sour: 0, umami: 7 },
    avoid: ['高脂'],
    steps: [
      '排骨冷水下锅，加姜片料酒焯水 3 分钟，撇净浮沫捞出。',
      '换清水 1.5L，放入排骨与姜片，大火烧开转小火炖 35 分钟。',
      '冬瓜去皮切厚片，入锅再炖 12 分钟。',
      '起锅前加盐与白胡椒粉调味。',
    ],
    video: true,
  },
  {
    id: 9,
    name: '杏鲍菇炒肉片',
    desc: '菌菇与瘦肉搭配，口感弹韧，鲜味十足。',
    time: 18,
    difficulty: '简单',
    cookware: '炒锅',
    ingredients: ['猪里脊', '杏鲍菇', '青椒'],
    seasoning: '生抽 10ml、蚝油 5g、蒜末、淀粉 3g',
    flavor: { salty: 5, sweet: 1, spicy: 2, sour: 0, umami: 6 },
    avoid: [],
    steps: [
      '猪里脊逆纹切薄片，加生抽、淀粉、少许油抓匀腌 10 分钟。',
      '杏鲍菇切菱形片，青椒切块。',
      '不粘锅少油，中火将杏鲍菇片煎至两面微焦后盛出。',
      '大火滑炒肉片至变色，回锅菇片与青椒，加蚝油翻炒均匀。',
    ],
    video: true,
  },
  {
    id: 10,
    name: '番茄牛腩',
    desc: '番茄果酸软化牛肉，汤汁浓郁，适合搭配主食。',
    time: 90,
    difficulty: '中等',
    cookware: '汤锅',
    ingredients: ['牛腩', '番茄', '土豆', '洋葱'],
    seasoning: '番茄膏 10g、生抽 15ml、姜片、八角 1 颗',
    flavor: { salty: 5, sweet: 2, spicy: 0, sour: 3, umami: 7 },
    avoid: ['高脂', '高盐'],
    steps: [
      '牛腩切 3cm 块，冷水焯水后洗净沥干。',
      '锅中少油炒香洋葱与姜片，加番茄块炒出汁，加番茄膏炒匀。',
      '下牛腩翻炒上色，加热水没过食材，放八角，小火炖 50 分钟。',
      '加入土豆块再炖 15 分钟，加生抽与盐调味收汁。',
    ],
    video: true,
  },
  {
    id: 11,
    name: '素三鲜',
    desc: '三种蔬菜同炒，颜色鲜亮，全素低卡。',
    time: 15,
    difficulty: '简单',
    cookware: '炒锅',
    ingredients: ['西兰花', '胡萝卜', '木耳'],
    seasoning: '盐 2g、蚝油 5g、蒜末、橄榄油 5ml',
    flavor: { salty: 3, sweet: 1, spicy: 0, sour: 0, umami: 4 },
    avoid: [],
    steps: [
      '木耳提前泡发撕小朵，西兰花切小朵，胡萝卜切片。',
      '木耳沸水焯 2 分钟，西兰花与胡萝卜焯 1 分钟。',
      '热锅少油爆香蒜末，倒入全部食材大火翻炒。',
      '加蚝油与盐炒匀，30 秒后出锅。',
    ],
    video: false,
  },
  {
    id: 12,
    name: '红薯燕麦粥',
    desc: '无添加糖的粗粮早餐，饱腹感强，血糖上升平缓。',
    time: 30,
    difficulty: '简单',
    cookware: '电饭煲',
    ingredients: ['红薯', '燕麦'],
    seasoning: '清水 800ml（可加牛奶 100ml）',
    flavor: { salty: 0, sweet: 4, spicy: 0, sour: 0, umami: 2 },
    avoid: [],
    steps: [
      '红薯去皮切 1cm 小丁，燕麦冲洗一遍。',
      '电饭煲加入清水、红薯丁，选择煮粥模式煮 20 分钟。',
      '加入燕麦继续煮 8 分钟至粘稠。',
      '关火后按口味添加牛奶，不加糖也有自然甜味。',
    ],
    video: false,
  },
  {
    id: 13,
    name: '空气炸锅香煎鸡胸',
    desc: '无油低脂高蛋白，健身增肌常备菜。',
    time: 20,
    difficulty: '简单',
    cookware: '空气炸锅',
    ingredients: ['鸡胸肉', '西兰花'],
    seasoning: '黑胡椒、生抽 8ml、迷迭香少许、盐 2g',
    flavor: { salty: 4, sweet: 0, spicy: 2, sour: 0, umami: 4 },
    avoid: [],
    steps: [
      '鸡胸肉横刀片成两片，用刀背拍松，加调料腌 15 分钟。',
      '空气炸锅 180℃ 预热 3 分钟。',
      '鸡胸入锅 180℃ 烤 12 分钟，翻面再烤 4 分钟。',
      '西兰花焯水 90 秒摆盘，静置 3 分钟后切条更嫩。',
    ],
    video: true,
  },
  {
    id: 14,
    name: '烤三文鱼时蔬',
    desc: '富含 Omega-3 的烤箱菜，一盘搞定蛋白与蔬菜。',
    time: 25,
    difficulty: '中等',
    cookware: '烤箱',
    ingredients: ['三文鱼', '洋葱', '南瓜'],
    seasoning: '海盐 3g、黑胡椒、柠檬汁 5ml、橄榄油 5ml',
    flavor: { salty: 4, sweet: 2, spicy: 0, sour: 1, umami: 7 },
    avoid: ['高脂'],
    steps: [
      '三文鱼用厨房纸吸干水分，抹海盐与黑胡椒腌 10 分钟。',
      '南瓜切厚片、洋葱切块，拌橄榄油与少许盐铺入烤盘。',
      '烤箱 200℃ 预热 5 分钟，蔬菜先烤 10 分钟。',
      '放上三文鱼同烤 10 分钟，出炉挤柠檬汁。',
    ],
    video: true,
  },
  {
    id: 15,
    name: '微波南瓜块',
    desc: '零油烟快手甜品菜，保留南瓜天然甜味。',
    time: 10,
    difficulty: '简单',
    cookware: '微波炉',
    ingredients: ['南瓜'],
    seasoning: '无需调料，可选少量肉桂粉',
    flavor: { salty: 0, sweet: 5, spicy: 0, sour: 0, umami: 2 },
    avoid: [],
    steps: [
      '南瓜去皮去瓤，切 2cm 见方的块。',
      '放入微波碗，加 2 勺清水，盖上保鲜膜扎几个孔。',
      '高火微波 5 分钟，取出翻拌一次。',
      '再微波 2 分钟至软糯，按口味撒肉桂粉。',
    ],
    video: false,
  },
  {
    id: 16,
    name: '冬瓜蛤蜊汤',
    desc: '海鲜自带鲜味无需味精，10 分钟快手汤。',
    time: 20,
    difficulty: '简单',
    cookware: '汤锅',
    ingredients: ['蛤蜊', '冬瓜'],
    seasoning: '姜丝 5g、香葱、盐 2g、香油 2 滴',
    flavor: { salty: 3, sweet: 0, spicy: 0, sour: 0, umami: 9 },
    avoid: ['高碘'],
    steps: [
      '蛤蜊加盐水静养 1 小时吐沙，反复搓洗干净。',
      '冬瓜去皮切薄片，姜切丝。',
      '锅中加水 800ml 与姜丝煮开，放入冬瓜煮 5 分钟。',
      '下蛤蜊煮至全部开口，撇浮沫，加盐与香油即可。',
    ],
    video: false,
  },
  {
    id: 17,
    name: '青椒肉丝',
    desc: '经典下饭菜，青椒富含维生素 C，快炒保留脆感。',
    time: 15,
    difficulty: '简单',
    cookware: '炒锅',
    ingredients: ['猪里脊', '青椒'],
    seasoning: '生抽 10ml、料酒 5ml、淀粉 3g、豆瓣酱 5g',
    flavor: { salty: 5, sweet: 1, spicy: 3, sour: 0, umami: 5 },
    avoid: ['辛辣'],
    steps: [
      '猪里脊顺纹切细丝，加生抽、料酒、淀粉抓匀腌 10 分钟。',
      '青椒去籽切丝，粗细与肉丝一致。',
      '热锅冷油下肉丝，快速划散至变色盛出。',
      '余油炒青椒 30 秒，回锅肉丝与豆瓣酱，大火炒匀出锅。',
    ],
    video: true,
  },
  {
    id: 18,
    name: '玉米排骨汤',
    desc: '清甜不油，玉米与胡萝卜提供天然糖分，少盐也鲜。',
    time: 70,
    difficulty: '简单',
    cookware: '汤锅',
    ingredients: ['玉米', '排骨', '胡萝卜'],
    seasoning: '姜片 3 片、料酒 10ml、盐 3g',
    flavor: { salty: 3, sweet: 3, spicy: 0, sour: 0, umami: 6 },
    avoid: ['高脂'],
    steps: [
      '排骨冷水下锅，加姜片料酒焯水后洗净。',
      '玉米切段，胡萝卜切滚刀块。',
      '砂锅加 2L 热水与排骨、姜片，小火炖 40 分钟。',
      '放入玉米与胡萝卜再炖 20 分钟，起锅前加盐。',
    ],
    video: true,
  },
  {
    id: 19,
    name: '番茄豆腐汤',
    desc: '植物蛋白搭配番茄果酸，10 分钟出锅的清爽汤品。',
    time: 10,
    difficulty: '简单',
    cookware: '汤锅',
    ingredients: ['番茄', '豆腐'],
    seasoning: '盐 2g、香油 2 滴、葱花少许',
    flavor: { salty: 3, sweet: 1, spicy: 0, sour: 3, umami: 5 },
    avoid: [],
    steps: [
      '嫩豆腐切 2cm 方块，淡盐水浸泡 3 分钟去豆腥。',
      '番茄去皮切块，热锅少油炒出红汁。',
      '加清水 700ml 煮开，放入豆腐块中火煮 3 分钟。',
      '加盐调味，淋香油撒葱花出锅。',
    ],
    video: true,
  },
  {
    id: 20,
    name: '虾仁蒸蛋',
    desc: '蛋白质丰富、口感嫩滑，适合老人与孩子。',
    time: 15,
    difficulty: '简单',
    cookware: '蒸锅',
    ingredients: ['鸡蛋', '虾仁', '葱'],
    seasoning: '温水 180ml、盐 2g、蒸鱼豉油 5ml',
    flavor: { salty: 3, sweet: 0, spicy: 0, sour: 0, umami: 7 },
    avoid: ['高碘'],
    steps: [
      '鸡蛋打散，加 1.5 倍温水与盐搅匀，过筛滤掉泡沫。',
      '碗口盖上保鲜膜并扎孔，水开后中小火蒸 8 分钟。',
      '摆上虾仁再蒸 3 分钟至虾变红。',
      '淋蒸鱼豉油与香油，撒葱花即可。',
    ],
    video: true,
  },
  {
    id: 21,
    name: '核桃拌菠菜',
    desc: '核桃提供优质脂肪酸，菠菜补铁，焯拌无油烟。',
    time: 12,
    difficulty: '简单',
    cookware: '汤锅',
    ingredients: ['菠菜', '核桃'],
    seasoning: '生抽 5ml、香醋 5ml、香油 2 滴',
    flavor: { salty: 3, sweet: 1, spicy: 0, sour: 2, umami: 3 },
    avoid: ['坚果过敏'],
    steps: [
      '核桃仁烤箱 150℃ 烤 5 分钟或干锅小火焙香，掰碎。',
      '菠菜洗净，沸水加少许盐焯 60 秒。',
      '捞出过冷水挤干水分，切成 4cm 段。',
      '拌入生抽、香醋、香油，撒核桃碎。',
    ],
    video: false,
  },
  {
    id: 22,
    name: '柠檬蜂蜜烤鸡腿',
    desc: '果酸软化肉质，烤制逼出多余油脂，比油炸健康。',
    time: 30,
    difficulty: '中等',
    cookware: '烤箱',
    ingredients: ['鸡腿肉', '柠檬'],
    seasoning: '蜂蜜 10g、生抽 10ml、黑胡椒、蒜 2 瓣',
    flavor: { salty: 4, sweet: 4, spicy: 1, sour: 3, umami: 6 },
    avoid: ['高糖'],
    steps: [
      '鸡腿去骨，用叉子在肉面扎孔便于入味。',
      '生抽、蜂蜜、蒜末、半个柠檬汁调成腌料，冷藏腌 20 分钟。',
      '烤箱 200℃ 预热，鸡皮朝上烤 15 分钟。',
      '翻面刷剩余腌料再烤 8 分钟，配柠檬片食用。',
    ],
    video: true,
  },
  {
    id: 23,
    name: '香菇烧豆腐',
    desc: '菌菇与豆香互相提味，少油焖煮，清淡下饭。',
    time: 20,
    difficulty: '简单',
    cookware: '炒锅',
    ingredients: ['豆腐', '香菇', '葱'],
    seasoning: '生抽 10ml、蚝油 5g、淀粉 3g、清水 100ml',
    flavor: { salty: 4, sweet: 1, spicy: 0, sour: 0, umami: 6 },
    avoid: [],
    steps: [
      '豆腐切 2cm 方块，淡盐水浸泡 5 分钟后沥干。',
      '香菇泡发切片，泡菇水留作汤汁。',
      '不粘锅少油，将豆腐块煎至两面微黄后盛出。',
      '下香菇炒香，回锅豆腐，加泡菇水与生抽焖 5 分钟，勾薄芡撒葱花。',
    ],
    video: true,
  },
  {
    id: 24,
    name: '白菜豆腐汤',
    desc: '零负担清汤，白菜清甜配豆腐嫩滑，适合控体重。',
    time: 15,
    difficulty: '简单',
    cookware: '汤锅',
    ingredients: ['豆腐', '白菜'],
    seasoning: '姜片 2 片、盐 2g、白胡椒粉少许、香油 2 滴',
    flavor: { salty: 3, sweet: 1, spicy: 0, sour: 0, umami: 5 },
    avoid: [],
    steps: [
      '白菜洗净，菜帮斜切片、菜叶撕大块分开放。',
      '豆腐切块，锅中加水 800ml 与姜片煮开。',
      '先下白菜帮煮 5 分钟，再放豆腐煮 4 分钟。',
      '最后放菜叶煮软，加盐、白胡椒粉与香油。',
    ],
    video: false,
  },
  {
    id: 25,
    name: '香煎嫩豆腐',
    desc: '只用少量油煎至金黄，外酥里嫩，蛋白质密度高。',
    time: 12,
    difficulty: '简单',
    cookware: '平底锅',
    ingredients: ['豆腐', '葱'],
    seasoning: '生抽 8ml、孜然粉少许、熟芝麻',
    flavor: { salty: 3, sweet: 0, spicy: 1, sour: 0, umami: 4 },
    avoid: [],
    steps: [
      '嫩豆腐切 1.5cm 厚片，厨房纸吸干表面水分。',
      '平底锅刷薄油，中火放入豆腐片，静置 3 分钟再翻面。',
      '两面煎至金黄后关火，趁热淋生抽。',
      '撒葱花、孜然粉与熟芝麻。',
    ],
    video: true,
  },
  {
    id: 26,
    name: '麻婆豆腐',
    desc: '经典川菜，麻辣鲜香，重口味下饭首选。',
    time: 20,
    difficulty: '中等',
    cookware: '炒锅',
    ingredients: ['豆腐', '猪里脊', '小米椒'],
    seasoning: '豆瓣酱 15g、花椒粉、生抽 5ml、淀粉 3g',
    flavor: { salty: 6, sweet: 0, spicy: 8, sour: 0, umami: 6 },
    avoid: ['辛辣', '高盐'],
    steps: [
      '豆腐切方块，淡盐水浸泡 5 分钟后沥干。',
      '猪里脊剁成肉末，小米椒切圈。',
      '锅中少油炒散肉末，加豆瓣酱与小米椒炒出红油。',
      '加清水 150ml 煮开，下豆腐中火烧 3 分钟，勾芡后撒花椒粉。',
    ],
    video: true,
  },
];

/* ---------- 菜谱来源：后端大库 + 内置 26 道（按菜名去重合并） ---------- */
function allRecipes() {
  if (!serverRecipes || !serverRecipes.length) return RECIPES;
  const seen = new Set();
  const merged = [];
  for (const r of [...serverRecipes, ...RECIPES]) {
    if (r && r.name && !seen.has(r.name)) {
      seen.add(r.name);
      merged.push(r);
    }
  }
  return merged;
}

const WEIGHTS = { ingredient: 0.5, flavor: 0.15, cookware: 0.15, keyword: 0.2 };

// "清淡/低盐"等倾向只对带相反标签的菜谱做软扣分，不直接过滤
const SOFT_PENALTY = 0.15;

const CUSTOM_STORE_KEY = 'healthy_recipe_custom_ingredients';

const state = {
  ingredients: new Set(),
  cookware: new Set(),
  avoids: new Set(),
  flavors: { salty: 5, sweet: 5, spicy: 5, sour: 5, umami: 5 },
  keywords: [],
  maxTime: null,
  softAvoids: new Set(),
  custom: new Set(loadCustom()),
  requestText: '',
};

function loadCustom() {
  if (typeof localStorage === 'undefined') return [];
  try {
    return JSON.parse(localStorage.getItem(CUSTOM_STORE_KEY) || '[]');
  } catch (e) {
    return [];
  }
}

function saveCustom() {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(CUSTOM_STORE_KEY, JSON.stringify([...state.custom]));
  } catch (e) {
    /* 隐私模式下 localStorage 不可用，忽略 */
  }
}

/* ============================================================
   菜谱账本：收藏 + 烹饪记账（localStorage 持久化，浏览器本地）
   ============================================================ */
const LEDGER_KEY = 'healthy_recipe_ledger_v1';

function loadLedger() {
  const empty = { favs: {}, cooks: {} }; // favs:{name:ts} cooks:{name:{c,last}}
  if (typeof localStorage === 'undefined') return empty;
  try {
    const raw = JSON.parse(localStorage.getItem(LEDGER_KEY) || '{}');
    return { favs: raw.favs || {}, cooks: raw.cooks || {} };
  } catch (e) {
    return empty;
  }
}

let ledger = loadLedger();

function saveLedger() {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(LEDGER_KEY, JSON.stringify(ledger));
  } catch (e) {
    /* 忽略 */
  }
}

function isFav(name) {
  return Object.prototype.hasOwnProperty.call(ledger.favs, name);
}

function cookCount(name) {
  const x = ledger.cooks[name];
  return x ? x.c : 0;
}

function toggleFav(name) {
  if (isFav(name)) delete ledger.favs[name];
  else ledger.favs[name] = Date.now();
  saveLedger();
}

function cookOnce(name) {
  const x = ledger.cooks[name] || { c: 0, last: 0 };
  ledger.cooks[name] = { c: x.c + 1, last: Date.now() };
  saveLedger();
}

function changeCook(name, delta) {
  const x = ledger.cooks[name] || { c: 0, last: 0 };
  const c = x.c + delta;
  if (c <= 0) delete ledger.cooks[name];
  else ledger.cooks[name] = { c, last: Date.now() };
  saveLedger();
}

function resetLedger() {
  ledger = { favs: {}, cooks: {} };
  saveLedger();
}

// 分页小控件：放在收藏/烹饪记录列表下面
function ledgerNavHtml(zone, page, total) {
  if (total <= 1) return '';
  const dataAttr = zone === 'fav' ? 'data-fpage' : 'data-cpage';
  const prev = Math.max(1, page - 1);
  const next = Math.min(total, page + 1);
  return `
    <div class="ledger-pager">
      <button type="button" class="lp-btn" ${dataAttr}="${prev}" ${page <= 1 ? 'disabled' : ''}>
        <i class="fa-solid fa-chevron-left"></i>
      </button>
      <span class="lp-info">${page} / ${total}</span>
      <button type="button" class="lp-btn" ${dataAttr}="${next}" ${page >= total ? 'disabled' : ''}>
        <i class="fa-solid fa-chevron-right"></i>
      </button>
    </div>`;
}

function renderLedger() {
  const favBox = document.getElementById('favList');
  const cookBox = document.getElementById('cookList');
  if (!favBox || !cookBox) return;

  // ---- 收藏：两列小方块 + 分页（每页 10 个）----
  const FAV_PAGE = 10;
  const favNames = Object.keys(ledger.favs).sort((a, b) => ledger.favs[b] - ledger.favs[a]);
  const favTotal = Math.max(1, Math.ceil(favNames.length / FAV_PAGE));
  if (favPage > favTotal) favPage = favTotal;
  const favChunk = favNames.slice((favPage - 1) * FAV_PAGE, favPage * FAV_PAGE);
  document.getElementById('favCount').textContent = favNames.length;
  favBox.innerHTML = favNames.length
    ? `
      <div class="ledger-grid">${favChunk
        .map(
          (n) => `
        <div class="fav-tile" title="${escapeHtml(n)}">
          <i class="fa-solid fa-star fav-tile-star"></i>
          <span class="fav-tile-name">${escapeHtml(n)}</span>
          <button type="button" class="ledger-x" data-unfav="${escapeHtml(n)}" title="取消收藏">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>`
        )
        .join('')}
      </div>
      ${ledgerNavHtml('fav', favPage, favTotal)}`
    : '<div class="ledger-empty"><i class="fa-regular fa-star"></i> 在菜谱卡片上点“收藏”，喜欢做的菜会出现在这里</div>';

  // ---- 烹饪记录：两列小方块 + 分页（每页 8 个）----
  const COOK_PAGE = 8;
  const cooks = Object.entries(ledger.cooks)
    .sort((a, b) => b[1].c - a[1].c || (b[1].last || 0) - (a[1].last || 0));
  const cookTotal = Math.max(1, Math.ceil(cooks.length / COOK_PAGE));
  if (cookPage > cookTotal) cookPage = cookTotal;
  const cookChunk = cooks.slice((cookPage - 1) * COOK_PAGE, cookPage * COOK_PAGE);
  document.getElementById('cookCount').textContent = cooks.length;
  const maxC = cooks.length ? cooks[0][1].c : 0;
  cookBox.innerHTML = cooks.length
    ? `
      <div class="ledger-grid">${cookChunk
        .map(
          ([n, x]) => `
        <div class="cook-tile" data-cook-tile="${escapeHtml(n)}"
             title="点方块：再记一次；悬停出现 −1 可撤销">
          <div class="cook-tile-head">
            <span class="cook-tile-name">${escapeHtml(n)}</span>
            <span class="cook-tile-times">×${x.c}</span>
          </div>
          <div class="cook-tile-bar"><i style="width:${maxC ? Math.max(8, Math.round((x.c / maxC) * 100)) : 8}%"></i></div>
          <div class="cook-tile-foot">
            <span class="cook-tile-last">${x.last ? new Date(x.last).toLocaleDateString('zh-CN') : '—'}</span>
            <button type="button" class="ledger-op cook-dec" data-dec="${escapeHtml(n)}" title="撤销一次（−1）">
              <i class="fa-solid fa-minus"></i>
            </button>
          </div>
        </div>`
        )
        .join('')}
      </div>
      ${ledgerNavHtml('cook', cookPage, cookTotal)}`
    : '<div class="ledger-empty"><i class="fa-solid fa-fire-burner"></i> 每做一道菜，点卡片上的“做一次”，自动累计次数</div>';

  // 悬浮按钮上的小角标：收藏 + 记录总数
  const dockBadge = document.getElementById('dockLedgerBadge');
  if (dockBadge) {
    const total = favNames.length + cooks.length;
    dockBadge.textContent = total;
    dockBadge.style.display = total ? 'inline-flex' : 'none';
  }
}

// 卡片上按钮状态的局部刷新（收藏星标 / 已做次数），避免整页重绘
function refreshFavUI(name) {
  document.querySelectorAll('.ledger-fav').forEach((b) => {
    if (b.dataset.fav !== name) return;
    const on = isFav(name);
    b.classList.toggle('btn-warning', on);
    b.classList.toggle('btn-outline-warning', !on);
    const label = b.querySelector('.fav-label');
    if (label) label.textContent = on ? '已收藏' : '收藏';
  });
}

function refreshCookUI(name) {
  const c = cookCount(name);
  document.querySelectorAll('[data-cookcount]').forEach((el) => {
    if (el.dataset.cookcount !== name) return;
    el.textContent = c ? ` · 已做 ${c} 次` : '';
  });
}

/* ---------- 每日菜谱推荐：从账本里提炼“口味画像” ---------- */
function buildDailyContext() {
  const fl = { salty: 0, sweet: 0, spicy: 0, sour: 0, umami: 0 };
  const ingW = {};
  const dishW = [];
  const lib = new Map(allRecipes().map((r) => [r.name, r]));
  let totalW = 0;

  const addDish = (name, w) => {
    const r = lib.get(name);
    if (!r) return;
    totalW += w;
    const rf = r.flavor || {};
    FLAVORS.forEach((f) => {
      fl[f.key] += (typeof rf[f.key] === 'number' ? rf[f.key] : 5) * w;
    });
    (r.ingredients || []).forEach((i) => {
      ingW[i] = (ingW[i] || 0) + w;
    });
    dishW.push([name, w]);
  };

  // 常做（做一次权重高） + 收藏（权重 1），综合成“最近的口味”
  for (const [nm, x] of Object.entries(ledger.cooks)) addDish(nm, x.c);
  for (const nm of Object.keys(ledger.favs)) addDish(nm, 1);

  if (!totalW) return null; // 账本为空：由 AI 按均衡口味推荐

  Object.keys(fl).forEach((k) => {
    fl[k] = Math.round(fl[k] / totalW);
  });
  const topIngredients = Object.entries(ingW)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([n]) => n);
  const topDishes = dishW.sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n]) => n);
  return { taste: fl, topIngredients, topDishes };
}

function renderDailyResult(data) {
  const box = document.getElementById('dailyResult');
  if (!box) return;
  const list = (data && data.推荐) || [];
  if (!list.length) {
    box.innerHTML = '<div class="daily-error">AI 没有返回有效菜单，请稍后再试。</div>';
    return;
  }
  const festMark = data.节日 ? ` · ${data.节日} 特供菜单` : '';
  const meta = data.季节 || data.天气 || data.日期 || data.节日
    ? `<div class="daily-meta">
         <i class="fa-solid fa-cloud-sun"></i>
         ${data.季节 ? data.季节 + '季' : ''}${data.天气 && data.天气 !== '—' ? ' · ' + data.天气 : ''}${data.日期 ? ' · ' + data.日期 : ''}${festMark}
       </div>`
    : '';
  const summary = data.搭配说明
    ? `<div class="daily-summary">${escapeHtml(data.搭配说明)}</div>`
    : '';
  const items = list
    .map((it) => {
      const nm = it.菜名 || '';
      const enc = encodeURIComponent(nm);
      return `
      <div class="daily-item">
        <div class="daily-item-head">
          <span class="daily-meal">${escapeHtml(it.餐次 || '推荐')}</span>
          <b>${escapeHtml(nm)}</b>
          ${it.用时分钟 ? `<span class="daily-min">约 ${it.用时分钟} 分钟</span>` : ''}
        </div>
        ${it.适合原因 ? `<div class="daily-why"><i class="fa-solid fa-leaf"></i> ${escapeHtml(it.适合原因)}</div>` : ''}
        ${it.做法思路 ? `<div class="daily-how"><i class="fa-solid fa-lightbulb"></i> ${escapeHtml(it.做法思路)}</div>` : ''}
        <div class="d-flex flex-wrap gap-2 mt-2">
          <a class="btn btn-sm btn-xcf" href="https://www.xiachufang.com/search/?keyword=${enc}" target="_blank" rel="noopener">
            <i class="fa-solid fa-utensils"></i> 下厨房看做法
          </a>
          <a class="btn btn-sm btn-outline-danger" href="https://search.bilibili.com/all?keyword=${encodeURIComponent(nm + ' 做法')}" target="_blank" rel="noopener">
            <i class="fa-brands fa-bilibili"></i> B站搜视频
          </a>
        </div>
      </div>`;
    })
    .join('');
  const tip = data.类型 ? `<div class="daily-tip">${escapeHtml(data.类型)}</div>` : '';
  box.innerHTML = meta + summary + items + tip;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

function allIngredients() {
  return [...INGREDIENT_CATEGORIES.flatMap((c) => c.items), ...state.custom];
}

/* ---------- 需求解析 ---------- */

const TIME_PATTERNS = [
  { re: /(\d+)\s*(?:分钟|分|min)/i, get: (m) => Number(m[1]) },
  { re: /半\s*个?\s*小时/, get: () => 30 },
  { re: /(\d+)\s*个?\s*小时/, get: (m) => Number(m[1]) * 60 },
];

const SPEED_WORDS = ['快手', '快速', '快点', '省事', '简单'];

// 先于词表匹配：以正则捕捉"不要海鲜/坚果过敏"这类带修饰语的表达
const DIET_REGEX = [
  { re: /(?:不[吃要]|没有|过敏|忌|避开)[^，。、；\s]{0,5}?海鲜/g, avoid: '高碘' },
  { re: /海鲜[^，。、；\s]{0,5}?(?:不[吃要]|过敏|忌)/g, avoid: '高碘' },
  { re: /(?:不[吃要]|没有|过敏|忌|避开)[^，。、；\s]{0,5}?坚果/g, avoid: '坚果过敏' },
  { re: /坚果[^，。、；\s]{0,5}?(?:不[吃要]|过敏|忌)/g, avoid: '坚果过敏' },
];

// 饮食倾向：命中后按词表内最长词处理一次
const DIET_RULES = [
  { words: ['低脂', '减脂', '少油', '低油', '不油腻'], avoids: ['高脂'], soft: ['高脂'], flavor: {} },
  { words: ['清淡', '清爽'], avoids: [], soft: ['高脂', '高盐', '辛辣'], flavor: { salty: -2, spicy: -2 } },
  { words: ['高盐', '重盐'], avoids: [], soft: [], flavor: { salty: 3 } },
  { words: ['低盐', '少盐', '控盐', '不咸'], avoids: ['高盐'], soft: ['高盐'], flavor: { salty: -3 } },
  { words: ['无糖', '少糖', '控糖', '低糖', '不甜'], avoids: ['高糖'], soft: ['高糖'], flavor: { sweet: -3 } },
  { words: ['不辣', '不吃辣', '不要辣', '免辣', '忌辣'], avoids: ['辛辣'], soft: ['辛辣'], flavor: { spicy: -5 } },
  { words: ['坚果过敏'], avoids: ['坚果过敏'], soft: [], flavor: {} },
  { words: ['海鲜过敏'], avoids: ['高碘'], soft: [], flavor: {} },
  { words: ['高蛋白', '增肌', '健身'], avoids: [], soft: ['高糖'], flavor: { sweet: -2 } },
  { words: ['重口味', '重口', '下饭', '咸香'], avoids: [], soft: [], flavor: { salty: 3 } },
  { words: ['素', '素食', '全素'], avoids: [], soft: ['高脂'], flavor: { salty: -1 } },
];

const FLAVOR_RULES = [
  { words: ['很辣', '重辣', '特辣', '爆辣', '巨辣'], key: 'spicy', value: 9 },
  { words: ['微辣', '有点辣', '小辣', '微微辣'], key: 'spicy', value: 5 },
  { words: ['中辣'], key: 'spicy', value: 7 },
  { words: ['辣'], key: 'spicy', value: 8 },
  { words: ['清淡', '清爽'], key: 'salty', value: 2 },
  { words: ['甜'], key: 'sweet', value: 7 },
  { words: ['酸甜', '开胃', '酸'], key: 'sour', value: 7 },
  { words: ['鲜美', '鲜香', '鲜味'], key: 'umami', value: 8 },
];

// 关键词清洗：剥离虚词后长度不足 2 的片段丢弃
const FILLER_RE = /[的了我想要做吃个和跟用内只点来一不很再还就就行把被给上下中家里有没在是也啊吧呢吗着过很太最]/g;
const STOP_WORDS = new Set(['随便', '什么', '怎么', '如何', '可以', '帮我', '一下', '好的']);

function parseRequest(text) {
  const raw = (text || '').trim();
  let rest = raw;
  const result = {
    ingredients: new Set(),
    cookware: new Set(),
    avoids: new Set(),
    soft: new Set(),
    flavors: {},
    keywords: [],
    maxTime: null,
  };

  if (!raw) return result;

  // 1. 时间
  for (const p of TIME_PATTERNS) {
    const m = rest.match(p.re);
    if (m) {
      result.maxTime = p.get(m);
      rest = rest.replace(m[0], ' ');
      break;
    }
  }
  if (result.maxTime === null) {
    const speed = SPEED_WORDS.find((w) => rest.includes(w));
    if (speed) {
      result.maxTime = 20;
      rest = rest.split(speed).join(' ');
    }
  }

  // 2. 带修饰语的忌口表达
  for (const rule of DIET_REGEX) {
    rest = rest.replace(rule.re, (m) => {
      result.avoids.add(rule.avoid);
      return ' ';
    });
  }

  // 3. 饮食倾向（长词优先，每个规则只命中一次）
  for (const rule of DIET_RULES) {
    const hit = [...rule.words].sort((a, b) => b.length - a.length).find((w) => rest.includes(w));
    if (hit) {
      rule.avoids.forEach((a) => result.avoids.add(a));
      (rule.soft || []).forEach((a) => result.soft.add(a));
      Object.entries(rule.flavor).forEach(([k, v]) => {
        result.flavors[k] = (result.flavors[k] || 0) + v;
      });
      rest = rest.split(hit).join(' ');
    }
  }

  // 4. 口味强度（数组顺序即优先级）
  for (const rule of FLAVOR_RULES) {
    const hit = rule.words.find((w) => rest.includes(w));
    if (hit) {
      result.flavors[rule.key] = rule.value;
      rest = rest.split(hit).join(' ');
    }
  }

  // 5. 食材
  for (const name of allIngredients()) {
    if (rest.includes(name)) {
      result.ingredients.add(name);
      rest = rest.split(name).join(' ');
    }
  }

  // 6. 厨具
  for (const c of COOKWARE) {
    if (rest.includes(c.name)) {
      result.cookware.add(c.name);
      rest = rest.split(c.name).join(' ');
      continue;
    }
    const short = c.name.replace(/锅$/, '');
    if (short.length >= 2 && short !== c.name && rest.includes(short)) {
      result.cookware.add(c.name);
      rest = rest.split(short).join(' ');
    }
  }

  // 7. 剩余内容作为关键词
  const seen = new Set();
  result.keywords = rest
    .replace(/[，。、；！？,.!?;:：\s（）()"']+/g, ' ')
    .split(' ')
    .map((s) => s.trim().replace(FILLER_RE, ''))
    .filter((s) => s.length >= 2 && !STOP_WORDS.has(s) && !seen.has(s) && seen.add(s));

  return result;
}

function applyRequest(text) {
  const p = parseRequest(text);
  state.requestText = text.trim();

  p.ingredients.forEach((i) => state.ingredients.add(i));
  p.cookware.forEach((c) => state.cookware.add(c));
  p.avoids.forEach((a) => state.avoids.add(a));
  p.soft.forEach((a) => state.softAvoids.add(a));
  Object.entries(p.flavors).forEach(([k, v]) => {
    state.flavors[k] = Math.max(0, Math.min(10, 5 + v));
  });
  state.keywords = p.keywords;
  state.maxTime = p.maxTime;

  document.getElementById('requestInput').value = text;
  renderFilters();
  render();
  renderSummary(p);
}

function renderSummary(p) {
  const box = document.getElementById('summaryBox');
  if (!state.requestText) {
    box.innerHTML = '';
    return;
  }

  const chips = [];
  p.ingredients.forEach((i) => chips.push({ cls: 'sum-ing', icon: 'fa-carrot', text: `食材：${i}` }));
  p.cookware.forEach((c) => chips.push({ cls: 'sum-cook', icon: 'fa-fire-burner', text: `厨具：${c}` }));
  p.avoids.forEach((a) => chips.push({ cls: 'sum-avoid', icon: 'fa-ban', text: `忌口：${a}` }));
  Object.entries(p.flavors).forEach(([k, v]) => {
    const label = FLAVORS.find((f) => f.key === k).label;
    chips.push({ cls: 'sum-flavor', icon: 'fa-sliders', text: `${label}度 ${5 + v}` });
  });
  if (p.maxTime) chips.push({ cls: 'sum-time', icon: 'fa-clock', text: `${p.maxTime} 分钟内` });
  p.keywords.forEach((k) =>
    chips.push({ cls: 'sum-key', icon: 'fa-magnifying-glass', text: `关键词：${escapeHtml(k)}` })
  );

  box.innerHTML = `
    <div class="summary-card">
      <div class="d-flex justify-content-between align-items-start flex-wrap gap-2">
        <div class="summary-title">
          <i class="fa-solid fa-wand-magic-sparkles text-success"></i>
          已分析你的需求：<span class="summary-quote">“${escapeHtml(state.requestText)}”</span>
        </div>
        <button type="button" class="btn btn-sm btn-outline-secondary" id="clearRequestBtn">
          <i class="fa-solid fa-xmark"></i> 清除需求
        </button>
      </div>
      <div class="d-flex flex-wrap gap-2 mt-2">
        ${
          chips.length
            ? chips.map((c) => `<span class="sum-chip ${c.cls}"><i class="fa-solid ${c.icon}"></i> ${c.text}</span>`).join('')
            : '<span class="text-muted small">没有识别出明确条件，已按关键词在菜名与做法中搜索。</span>'
        }
      </div>
    </div>`;

  document.getElementById('clearRequestBtn').addEventListener('click', clearRequest);
}

function clearRequest() {
  state.requestText = '';
  state.keywords = [];
  state.maxTime = null;
  state.softAvoids.clear();
  document.getElementById('requestInput').value = '';
  renderSummary(null);
  render();
}

/* ---------- 推荐算法 ---------- */

function matchRecipe(recipe) {
  // 容错：从网页收录进本地库的条目可能缺字段（空食材/口味等），给安全默认
  recipe.ingredients = recipe.ingredients || [];
  recipe.avoid = recipe.avoid || [];
  recipe.flavor = recipe.flavor || {};
  recipe.seasoning = recipe.seasoning || '';
  recipe.desc = recipe.desc || '';

  const reasons = [];
  let score = 0;
  let weightSum = 0;
  let hitCount = 0;

  if (state.ingredients.size) {
    weightSum += WEIGHTS.ingredient;
    const matched = recipe.ingredients.filter((i) => state.ingredients.has(i));
    hitCount = matched.length;
    score += WEIGHTS.ingredient * (matched.length / Math.max(1, recipe.ingredients.length));
    reasons.push(`食材匹配 ${matched.length}/${recipe.ingredients.length}`);
  }

  if (state.cookware.size) {
    weightSum += WEIGHTS.cookware;
    const has = state.cookware.has(recipe.cookware);
    score += WEIGHTS.cookware * (has ? 1 : 0.3);
    reasons.push(has ? `${recipe.cookware}已备` : `${recipe.cookware}未备`);
  }

  if (state.keywords.length) {
    weightSum += WEIGHTS.keyword;
    const text = [recipe.name, recipe.desc, recipe.ingredients.join(''), recipe.seasoning].join(' ');
    const hit = state.keywords.find((k) => text.includes(k));
    score += WEIGHTS.keyword * (hit ? 1 : 0.15);
    if (hit) {
      reasons.push(`命中“${hit}”`);
      hitCount += 1;
    }
  }

  const softHit = recipe.avoid.filter((a) => state.softAvoids.has(a));
  if (softHit.length) {
    score -= SOFT_PENALTY * softHit.length;
    reasons.push(`偏${softHit.join('/')}，已降权`);
  }

  const diffs = FLAVORS.map((f) => {
    const rv = typeof recipe.flavor[f.key] === 'number' ? recipe.flavor[f.key] : 5;
    return Math.abs(rv - state.flavors[f.key]);
  });
  const flavorScore = 1 - diffs.reduce((a, b) => a + b, 0) / (FLAVORS.length * 10);

  let percent;
  if (weightSum === 0) {
    // 未选食材与厨具时，仅按口味接近度排序
    percent = Math.round(flavorScore * 100);
    reasons.push('按口味推荐');
  } else {
    weightSum += WEIGHTS.flavor;
    score += WEIGHTS.flavor * flavorScore;
    percent = Math.max(3, Math.round((Math.max(0, score) / weightSum) * 100));
    if (percent >= 75) reasons.push('口味接近');
  }

  return { recipe, percent, hitCount, reasons };
}

function getRecommendations() {
  const exact = [];
  const weak = [];
  let blocked = 0;
  let timeBlocked = 0;

  for (const recipe of allRecipes()) {
    if ((recipe.avoid || []).some((a) => state.avoids.has(a))) {
      blocked += 1;
      continue;
    }
    if (state.maxTime !== null && recipe.time && recipe.time > state.maxTime) {
      timeBlocked += 1;
      continue;
    }

    const m = matchRecipe(recipe);
    // 选中了食材或输入了关键词时，命中任一条件的进精准区，否则视为弱相关
    const needHit = state.ingredients.size > 0 || state.keywords.length > 0;
    if (!needHit || m.hitCount > 0) exact.push(m);
    else weak.push(m);
  }

  const byScore = (a, b) => b.percent - a.percent || a.recipe.time - b.recipe.time;
  exact.sort(byScore);
  weak.sort(byScore);

  return { exact, weak, blocked, timeBlocked };
}

/* ---------- 渲染 ---------- */

function renderFilters() {
  const box = document.getElementById('ingredientBox');
  box.innerHTML = INGREDIENT_CATEGORIES.map(
    (cat) => `
      <div class="filter-block filter-block-cat">
        <div class="filter-title">
          <i class="fa-solid ${cat.icon} text-success"></i> ${cat.name}
        </div>
        <div class="chip-grid">
          ${cat.items
            .map(
              (item) => `
            <button type="button" class="chip ${state.ingredients.has(item) ? 'chip-active' : ''}"
                    data-type="ingredient" data-value="${item}">${item}</button>`
            )
            .join('')}
        </div>
      </div>`
  ).join('');

  const customChips = [...state.custom]
    .map(
      (item) => `
      <span class="chip chip-custom ${state.ingredients.has(item) ? 'chip-active' : ''}"
            data-type="ingredient" data-value="${escapeHtml(item)}">
        ${escapeHtml(item)}
        <i class="fa-solid fa-xmark chip-remove" data-remove="${escapeHtml(item)}" title="删除"></i>
      </span>`
    )
    .join('');

  document.getElementById('customBox').innerHTML = customChips
    ? `<div class="d-flex flex-wrap gap-2">${customChips}</div>
       <div class="hint-text mt-2"><i class="fa-regular fa-circle-question"></i> 点击标签选中，点 × 删除；自定义食材会保存在本地浏览器中。</div>`
    : '<div class="hint-text"><i class="fa-regular fa-circle-question"></i> 还没有自定义食材，在下方输入框添加你常买的食材。</div>';

  document.getElementById('cookwareBox').innerHTML = COOKWARE.map(
    (c) => `
      <button type="button" class="chip ${state.cookware.has(c.name) ? 'chip-active' : ''}"
              data-type="cookware" data-value="${c.name}">
        <i class="fa-solid ${c.icon}"></i> ${c.name}
      </button>`
  ).join('');

  document.getElementById('flavorBox').innerHTML = FLAVORS.map(
    (f) => `
      <div class="flavor-row">
        <span class="flavor-label"><i class="fa-solid ${f.icon}"></i> ${f.label}</span>
        <input type="range" class="form-range flavor-range" min="0" max="10" step="1"
               value="${state.flavors[f.key]}" data-flavor="${f.key}">
        <span class="flavor-value" data-value-for="${f.key}">${state.flavors[f.key]}</span>
      </div>`
  ).join('');

  document.getElementById('avoidBox').innerHTML = AVOID_OPTIONS.map(
    (a) => `
      <div class="form-check">
        <input class="form-check-input" type="checkbox" value="${a}" id="avoid-${a}"
               data-type="avoid" ${state.avoids.has(a) ? 'checked' : ''}>
        <label class="form-check-label" for="avoid-${a}">${a}</label>
      </div>`
  ).join('');
}

function externalCardHtml({ recipe }) {
  // 库外结果卡片：菜名/简介来自网页搜索原文，只展示真实拿到的信息，
  // 不做任何“编造”（不显示时间/难度/厨具/步骤等未知字段），并给出可点击的来源。
  const tiltCls =
    [...recipe.name].reduce((a, c) => a + c.charCodeAt(0), 0) % 2 ? 'note-r' : 'note-l';
  return `
      <div class="col-12 col-md-6 col-xxl-3">
        <div class="card recipe-card h-100 c-web ${tiltCls}">
          <div class="card-body d-flex flex-column">
            <div class="d-flex justify-content-between align-items-start gap-2">
              <h5 class="recipe-name mb-0">
                <i class="fa-solid fa-globe text-primary"></i> ${recipe.name}
              </h5>
              <span class="match-badge match-mid">🌐 全网检索</span>
            </div>

            <p class="recipe-desc mt-2">${recipe.desc}</p>

            <div class="mb-2">
              <span class="tag tag-seasoning"><i class="fa-solid fa-link"></i> 来源：${recipe.sourceName}</span>
            </div>

            <div class="ledger-actions mt-auto">
              <button type="button" class="btn btn-sm ${isFav(recipe.name) ? 'btn-warning' : 'btn-outline-warning'} ledger-fav"
                      data-fav="${escapeHtml(recipe.name)}" title="收藏 / 取消收藏">
                <i class="fa-solid fa-star"></i> <span class="fav-label">${isFav(recipe.name) ? '已收藏' : '收藏'}</span>
              </button>
              <button type="button" class="btn btn-sm btn-outline-secondary ledger-cook"
                      data-cook="${escapeHtml(recipe.name)}" title="记录一次烹饪">
                <i class="fa-solid fa-fire-burner"></i> 做一次
                <span class="cook-note" data-cookcount="${escapeHtml(recipe.name)}">${cookCount(recipe.name) ? ` · 已做 ${cookCount(recipe.name)} 次` : ''}</span>
              </button>
            </div>

            <div class="d-flex flex-wrap gap-2 mt-3">
              ${
                addedLibNames.has(recipe.name)
                  ? `<button type="button" class="btn btn-sm btn-outline-secondary" disabled>
                       <i class="fa-solid fa-check"></i> 已加入菜谱库
                     </button>`
                  : `<button type="button" class="btn btn-sm btn-success add-lib-btn" data-addlib="${escapeHtml(recipe.name)}"
                            title="把这条真实菜谱收录进本地菜谱库，之后本地检索也能找到">
                       <i class="fa-solid fa-download"></i> 加入菜谱库
                     </button>`
              }
              <a class="btn btn-sm btn-outline-primary" href="${recipe.sourceUrl}" target="_blank" rel="noopener">
                <i class="fa-solid fa-arrow-up-right-from-square"></i> 查看原食谱
              </a>
            </div>
          </div>
        </div>
      </div>`;
}

function cardHtml({ recipe, percent, reasons }, isWeak) {
  // 防幻觉：网页检索结果走独立卡片（字段缺失不编造）
  if (recipe.origin === 'web') return externalCardHtml({ recipe });
  const level = percent >= 75 ? 'high' : percent >= 55 ? 'mid' : 'low';
  // 分类视觉钩子：顶部渐变条按菜类别上色（汤=蓝、蒸=青、烤=橙…）
  const CAT_CLS = {
    汤羹: 'c-soup',
    蒸炖: 'c-steam',
    烤炸: 'c-roast',
    凉拌: 'c-salad',
    主食: 'c-staple',
    荤菜: 'c-meat',
    素菜蛋豆: 'c-veg',
  };
  const catCls = recipe.origin === 'web' ? 'c-web' : CAT_CLS[classifyRecipe(recipe)] || 'c-veg';
  // 便签歪斜方向（按菜名确定性交替，重绘时不会乱跳）
  const tiltCls =
    [...recipe.name].reduce((a, c) => a + c.charCodeAt(0), 0) % 2 ? 'note-r' : 'note-l';
  // 直达入口：下厨房（真实图文菜谱站）按菜名搜索 + （可选）B 站搜视频教程
  const xcfUrl = `https://www.xiachufang.com/search/?keyword=${encodeURIComponent(recipe.name)}`;
  const videoUrl = recipe.video
    ? `https://search.bilibili.com/all?keyword=${encodeURIComponent(recipe.name + ' 做法')}`
    : null;
  // 菜谱账本联动：该菜是否已收藏 / 做过几次
  const favOn = isFav(recipe.name);
  const doneTimes = cookCount(recipe.name);
  const escName = escapeHtml(recipe.name);

  return `
      <div class="col-12 col-md-6 col-xxl-3">
        <div class="card recipe-card h-100 ${isWeak ? 'recipe-card-weak' : ''} ${catCls} ${tiltCls}">
          <div class="card-body d-flex flex-column">
            <div class="d-flex justify-content-between align-items-start gap-2">
              <h5 class="recipe-name mb-0">
                <i class="fa-solid fa-bowl-food ${isWeak ? 'text-secondary' : 'text-success'}"></i> ${recipe.name}
              </h5>
              <span class="match-badge match-${isWeak ? 'low' : level}">${percent}%</span>
            </div>

            <div class="progress match-progress my-2">
              <div class="progress-bar bg-${!isWeak && level === 'high' ? 'success' : !isWeak && level === 'mid' ? 'warning' : 'secondary'}"
                   style="width:${percent}%"></div>
            </div>

            <div class="recipe-meta">
              ${recipe.time ? `<span><i class="fa-regular fa-clock"></i> 约 ${recipe.time} 分钟</span>` : ''}
              ${recipe.cookware ? `<span><i class="fa-solid fa-fire-burner"></i> ${recipe.cookware}</span>` : ''}
              ${recipe.difficulty ? `<span><i class="fa-solid fa-layer-group"></i> ${recipe.difficulty}</span>` : ''}
            </div>

            <p class="recipe-desc">${recipe.desc}</p>

            <div class="mb-2">
              ${(recipe.ingredients || [])
                .map(
                  (i) =>
                    `<span class="tag ${state.ingredients.has(i) ? 'tag-hit' : ''}">${i}</span>`
                )
                .join('')}
              ${recipe.seasoning ? `<span class="tag tag-seasoning" title="辅料">${recipe.seasoning}</span>` : ''}
              ${
                recipe.sourceUrl
                  ? `<span class="tag tag-seasoning" title="从网页收录的真实菜谱"><i class="fa-solid fa-link"></i> 收录自 ${recipe.sourceName || '网页'}</span>`
                  : ''
              }
            </div>

            ${
              recipe.avoid.length
                ? `<div class="mb-2">${recipe.avoid
                    .map((a) => `<span class="tag tag-warn"><i class="fa-solid fa-triangle-exclamation"></i> ${a}</span>`)
                    .join('')}</div>`
                : ''
            }

            <div class="reason-line mt-auto">${reasons.join(' · ') || '综合推荐'}</div>

            <div class="ledger-actions mt-2">
              <button type="button" class="btn btn-sm ${favOn ? 'btn-warning' : 'btn-outline-warning'} ledger-fav"
                      data-fav="${escName}" title="收藏 / 取消收藏">
                <i class="fa-solid fa-star"></i> <span class="fav-label">${favOn ? '已收藏' : '收藏'}</span>
              </button>
              <button type="button" class="btn btn-sm btn-outline-secondary ledger-cook"
                      data-cook="${escName}" title="记录一次烹饪">
                <i class="fa-solid fa-fire-burner"></i> 做一次
                <span class="cook-note" data-cookcount="${escName}">${doneTimes ? ` · 已做 ${doneTimes} 次` : ''}</span>
              </button>
            </div>

            <div class="d-flex flex-wrap gap-2 mt-3">
              ${
                recipe.steps.length
                  ? `<button class="btn btn-sm btn-outline-success" type="button" data-bs-toggle="collapse"
                          data-bs-target="#steps-${recipe.id}" aria-expanded="false">
                       <i class="fa-solid fa-list-ol"></i> 做法步骤
                     </button>`
                  : ''
              }
              <a class="btn btn-sm btn-xcf" href="${xcfUrl}" target="_blank" rel="noopener">
                <i class="fa-solid fa-utensils"></i> 下厨房搜做法
              </a>
              ${
                recipe.sourceUrl
                  ? `<a class="btn btn-sm btn-outline-primary" href="${recipe.sourceUrl}" target="_blank" rel="noopener">
                       <i class="fa-solid fa-arrow-up-right-from-square"></i> 查看原食谱
                     </a>`
                  : ''
              }
              ${
                videoUrl
                  ? `<a class="btn btn-sm btn-outline-danger" href="${videoUrl}" target="_blank" rel="noopener" title="打开 B 站搜索相关视频教程">
                       <i class="fa-brands fa-bilibili"></i> B站搜视频
                     </a>`
                  : ''
              }
            </div>

            <div class="collapse mt-3" id="steps-${recipe.id}">
              <div class="steps-box">
                <ol class="mb-0 ps-3">
                  ${recipe.steps.map((s) => `<li class="mb-1">${s}</li>`).join('')}
                </ol>
              </div>
            </div>
          </div>
        </div>
      </div>`;
}

/* ---------- 分类与分页 ----------
   菜谱库没有现成“荤/素/汤/蒸”字段，这里按菜名/做法/厨具/食材启发式归类；
   归不准的落入“素菜蛋豆/其他”，但分类+分页的本意是减少长滚动，够用即可。 */

const CAT_ORDER = ['汤羹', '蒸炖', '烤炸', '凉拌', '主食', '荤菜', '素菜蛋豆'];

function classifyRecipe(r) {
  const FULL = [r.name, r.desc, (r.ingredients || []).join(' '), r.cookware].join(' ');
  const has = (...xs) => xs.some((x) => FULL.includes(x));
  if (has('汤', '羹', '炖', '煲')) return '汤羹';
  if ((r.cookware && r.cookware.includes('蒸')) || has('蒸')) return '蒸炖';
  if (has('烤')) return '烤炸';
  if (has('凉拌', '拌黄瓜', '沙拉')) return '凉拌';
  if (has('米饭', '面条', '馒头', '粥', '饺子', '玉米', '红薯', '土豆', '燕麦', '全麦面包', '年糕')) return '主食';
  if (has('鸡胸肉', '鸡腿肉', '猪里脊', '牛腩', '排骨', '五花肉', '牛肉', '猪肉', '鸡翅', '鸡丁', '肉末')) return '荤菜';
  if (has('鲈鱼', '虾仁', '三文鱼', '蛤蜊', '鱿鱼', '带鱼')) return '荤菜';
  return '素菜蛋豆';
}

function catTabsHtml(zone, pool, active) {
  // 只显示池子里真实存在的分类，避免一排空标签
  const present = [...new Set(pool.map((m) => classifyRecipe(m.recipe)))];
  const cats = ['all', ...CAT_ORDER.filter((c) => present.includes(c))];
  return cats
    .map(
      (c) =>
        `<button type="button" class="res-tab ${active === c ? 'tab-on' : ''}" data-zone="${zone}" data-cat="${c}">${c === 'all' ? '全部' : c}</button>`
    )
    .join('');
}

function pagerHtml(zone, page, total) {
  if (total <= 1) return '';
  const btns = [];
  const push = (p, label, on) =>
    btns.push(`<button type="button" class="pg-btn ${on ? 'pg-on' : ''}" data-zone="${zone}" data-page="${p}">${label}</button>`);
  const DOTS = `<span class="pg-dots">…</span>`;
  if (total <= 7) {
    for (let p = 1; p <= total; p++) push(p, p, p === page);
  } else {
    push(1, 1, page === 1);
    let s = Math.max(2, page - 1);
    let e = Math.min(total - 1, page + 1);
    if (s > 2) btns.push(DOTS);
    for (let p = s; p <= e; p++) push(p, p, p === page);
    if (e < total - 1) btns.push(DOTS);
    push(total, total, page === total);
  }
  btns.push(`<span class="pg-info">第 ${page} / ${total} 页</span>`);
  return `<div class="res-pager">${btns.join('')}</div>`;
}

function pagedHtml(pool, page) {
  const total = Math.max(1, Math.ceil(pool.length / PAGE_SIZE));
  const cur = Math.min(page, total);
  const slice = pool.slice((cur - 1) * PAGE_SIZE, cur * PAGE_SIZE);
  return { html: slice, cur, total };
}

function renderResults() {
  const { exact, weak, blocked, timeBlocked } = getRecommendations();
  const container = document.getElementById('resultGrid');

  // 筛选条件一变，就清掉上次的补充检索结果（条件指纹比对）
  const sig = [
    [...state.ingredients].sort().join(),
    [...state.cookware].sort().join(),
    [...state.avoids].sort().join(),
    state.keywords.join(),
    JSON.stringify(state.flavors),
    String(state.maxTime ?? ''),
    state.requestText,
  ].join('|');
  if (sig !== lastSig) {
    lastSig = sig;
    aiExtra = [];
    // 条件变了：分类/页码/折叠状态回到默认
    catExact = 'all';
    pageExact = 1;
    catWeak = 'all';
    pageWeak = 1;
    weakOpen = null;
  }

  document.getElementById('statTotal').textContent = allRecipes().length;
  document.getElementById('statMatched').textContent = exact.length;
  document.getElementById('statWeak').textContent = weak.length;
  document.getElementById('statWeakWrap').style.display = weak.length ? '' : 'none';
  document.getElementById('statBlocked').textContent = blocked;
  document.getElementById('statBlockedWrap').style.display = blocked ? '' : 'none';

  document.getElementById('statTime').textContent = timeBlocked;
  document.getElementById('statTimeWrap').style.display = state.maxTime !== null ? '' : 'none';
  document.getElementById('statTimeLabel').textContent = `${state.maxTime} 分钟内`;

  // “AI 再找几道”按钮：常显。点击后后端先排除已展示的库内菜，
  // 再从全网检索真实菜谱（附来源链接）补足 —— 只检索不生成
  const aiBtn = document.getElementById('aiMoreBtn');
  if (aiBtn) {
    aiBtn.style.display = '';
  }

  if (!exact.length && !weak.length && !aiExtra.length) {
    container.innerHTML = `
      <div class="col-12">
        <div class="empty-state text-center py-5">
          <i class="fa-regular fa-face-frown-open fa-3x text-muted mb-3"></i>
          <h5>没有符合条件的菜谱</h5>
          <p class="text-muted mb-0">试着减少忌口选项，或放宽食材与厨具要求。</p>
        </div>
      </div>`;
    return;
  }

  let html = '';

  if (exact.length) {
    // 精准区：按分类过滤 → 分页
    const pool = exact.filter((m) => catExact === 'all' || classifyRecipe(m.recipe) === catExact);
    const { html: slice, cur, total } = pagedHtml(pool, pageExact);
    pageExact = cur;
    html += `
      <div class="col-12">
        <div class="res-toolbar">
          <div class="res-tabs">${catTabsHtml('exact', exact, catExact)}</div>
          ${pagerHtml('exact', cur, total)}
        </div>
        ${
          slice.length
            ? `<div class="row g-3">${slice.map((m) => cardHtml(m, false)).join('')}</div>`
            : '<div class="empty-cat">这个分类下暂时没有精准匹配的菜，可以看看其他分类</div>'
        }
      </div>`;
  }

  if (aiExtra.length) {
    // AI 补菜（检索式）：库内放宽时间补的菜 + 全网搜索到的真实菜谱（附来源链接）
    html += `
      <div class="col-12">
        <div class="weak-zone">
          <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-2">
            <div>
              <span class="weak-title"><i class="fa-solid fa-wand-magic-sparkles text-success"></i> AI 补充（检索，非生成）</span>
              <span class="weak-sub">先从菜谱库放宽时间补，再从全网检索真实菜谱——每条都带来源，可点击查看原网页</span>
            </div>
          </div>
          <div class="row g-3">${aiExtra.map((m) => cardHtml(m, false)).join('')}</div>
        </div>
      </div>`;
  }

  if (weak.length) {
    // 有精准结果时默认收起弱相关，避免干扰；用户手动展开/收起会记住状态
    const open = weakOpen === null ? exact.length === 0 : weakOpen;
    const pool = weak.filter((m) => catWeak === 'all' || classifyRecipe(m.recipe) === catWeak);
    const { html: slice, cur, total } = pagedHtml(pool, pageWeak);
    pageWeak = cur;
    html += `
      <div class="col-12">
        <div class="weak-zone">
          <div class="d-flex flex-wrap justify-content-between align-items-center gap-2">
            <div>
              <span class="weak-title"><i class="fa-regular fa-circle"></i> 弱相关菜谱</span>
              <span class="weak-sub">没用到你选的食材，仅口味或时间相符</span>
            </div>
            <button class="btn btn-sm btn-outline-secondary" type="button" data-bs-toggle="collapse"
                    data-bs-target="#weakGrid" aria-expanded="${open}">
              <span class="weak-toggle-text">${open ? '收起' : '展开'}</span> ${weak.length} 道
              <i class="fa-solid fa-chevron-down"></i>
            </button>
          </div>
          <div class="collapse ${open ? 'show' : ''} mt-3" id="weakGrid">
            <div class="res-toolbar">
              <div class="res-tabs">${catTabsHtml('weak', weak, catWeak)}</div>
              ${pagerHtml('weak', cur, total)}
            </div>
            ${
              slice.length
                ? `<div class="row g-3">${slice.map((m) => cardHtml(m, true)).join('')}</div>`
                : '<div class="empty-cat">这个分类下暂时没有弱相关菜谱</div>'
            }
          </div>
        </div>
      </div>`;
  }

  container.innerHTML = html;
}

function render() {
  renderResults();
  document.getElementById('selectedCount').textContent =
    state.ingredients.size + state.cookware.size + state.avoids.size;
}

/* ---------- 事件绑定 ---------- */

function onChipClick(e) {
  if (e.target.closest('.chip-remove')) {
    const name = e.target.closest('.chip-remove').dataset.remove;
    state.custom.delete(name);
    state.ingredients.delete(name);
    saveCustom();
    renderFilters();
    renderResults();
    return;
  }

  const chip = e.target.closest('.chip');
  if (!chip) return;
  const { type, value } = chip.dataset;
  const set = type === 'ingredient' ? state.ingredients : state.cookware;

  if (set.has(value)) set.delete(value);
  else set.add(value);

  chip.classList.toggle('chip-active');
  renderResults();
}

function addCustomIngredient() {
  const input = document.getElementById('customInput');
  const name = input.value.trim().replace(/[<>]/g, '').slice(0, 10);
  if (!name) return;

  state.custom.add(name);
  state.ingredients.add(name);
  saveCustom();
  input.value = '';
  renderFilters();
  renderResults();
}

function onFlavorInput(e) {
  const key = e.target.dataset.flavor;
  if (!key) return;
  state.flavors[key] = Number(e.target.value);
  document.querySelector(`[data-value-for="${key}"]`).textContent = e.target.value;
  renderResults();
}

function onAvoidChange(e) {
  const value = e.target.value;
  if (e.target.checked) state.avoids.add(value);
  else state.avoids.delete(value);
  render();
}

function resetAll() {
  state.ingredients.clear();
  state.cookware.clear();
  state.avoids.clear();
  state.keywords = [];
  state.maxTime = null;
  state.softAvoids.clear();
  state.requestText = '';
  Object.keys(state.flavors).forEach((k) => (state.flavors[k] = 5));
  document.getElementById('requestInput').value = '';
  renderSummary(null);
  renderFilters();
  render();
}

/* ---------- AI 补菜（检索式，防幻觉） ----------
   允许 AI 补菜，但不允许“生成”菜谱。点击后请求后端两步检索：
   1) 菜谱库内放宽时间闸门（≤15 分钟）补几道；
   2) 不够数时用网页搜索（Tavily）检索全网真实菜谱，
      库外条目带 origin:"web" 与来源链接，前端显示“查看原食谱”。
   全程没有一行“让模型写一道菜”的代码。 */
async function onAiMore() {
  const btn = document.getElementById('aiMoreBtn');
  if (!btn) return;

  // 已展示的菜名全部传给后端排除，避免补重复
  const cur = getRecommendations();
  const excludeNames = [
    ...cur.exact.map((m) => m.recipe.name),
    ...cur.weak.map((m) => m.recipe.name),
    ...aiExtra.map((m) => m.recipe.name),
  ];

  const body = {
    ingredients: [...state.ingredients],
    cookware: [...state.cookware],
    avoids: [...state.avoids],
    flavors: { ...state.flavors },
    keywords: state.keywords,
    maxTime: state.maxTime,
    requestText: state.requestText,
    count: 4,
    excludeNames,
  };

  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 检索中…';
  try {
    const resp = await fetch(`${API_BASE}/api/supplement`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${resp.status}`);
    }
    const data = await resp.json();
    const list = (data && data.推荐) || [];
    if (!list.length) {
      const note = (data && data.note) || '没有更多符合条件的菜谱，请调整或放宽筛选条件。';
      alert(`没补到更多菜谱：\n${note}`);
      return;
    }
    for (const recipe of list) {
      aiSeq += 1;
      const isWeb = recipe.origin === 'web';
      let wrapper;
      if (isWeb) {
        // 库外结果：匹配度不适用；来源信息由卡片标签与“查看原食谱”按钮展示，不再写重复文案
        wrapper = {
          recipe: { ...recipe, id: -(1000 + aiSeq) },
          percent: 0,
          hitCount: 0,
          reasons: [],
        };
      } else {
        // 库内补的菜：用真实评分函数算分，理由如实展示
        const m = matchRecipe(recipe);
        wrapper = {
          recipe: { ...recipe, id: -(1000 + aiSeq) },
          percent: m.percent,
          hitCount: m.hitCount,
          reasons: m.reasons.length ? m.reasons : ['菜谱库内放宽时间补到'],
        };
      }
      aiExtra.push(wrapper);
    }
    renderResults();
  } catch (e) {
    alert(
      'AI 检索失败：' + e.message +
      '\n\n请确认：\n1) 后端已启动（uvicorn main:app --reload）\n' +
      '2) 库内补充不需要密钥；要启用“全网真实菜谱检索”，在 backend/.env 填入 TAVILY_API_KEY（https://app.tavily.com 免费申请）'
    );
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> AI 再找几道（检索）';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  renderFilters();
  render();
  renderLedger();   // 初始化菜谱账本侧栏

  document.getElementById('ingredientBox').addEventListener('click', onChipClick);
  document.getElementById('cookwareBox').addEventListener('click', onChipClick);
  document.getElementById('flavorBox').addEventListener('input', onFlavorInput);
  document.getElementById('avoidBox').addEventListener('change', onAvoidChange);
  document.getElementById('resetBtn').addEventListener('click', resetAll);

  document.getElementById('customBox').addEventListener('click', onChipClick);
  document.getElementById('customAddBtn').addEventListener('click', addCustomIngredient);
  document.getElementById('customInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addCustomIngredient();
  });

  const requestInput = document.getElementById('requestInput');
  document.getElementById('analyzeBtn').addEventListener('click', () => applyRequest(requestInput.value));
  requestInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applyRequest(requestInput.value);
  });

  document.getElementById('exampleBox').addEventListener('click', (e) => {
    const btn = e.target.closest('.example-chip');
    if (!btn) return;
    applyRequest(btn.dataset.text);
  });

  const aiMoreBtn = document.getElementById('aiMoreBtn');
  if (aiMoreBtn) aiMoreBtn.addEventListener('click', onAiMore);

  // 启动时拉取后端大菜谱库；后端没开就静默退回内置 26 道，页面照常能用
  fetch(`${API_BASE}/api/recipes`)
    .then((r) => r.json())
    .then((d) => {
      if (Array.isArray(d.recipes) && d.recipes.length) {
        serverRecipes = d.recipes;
        // 同步"哪些全网菜谱已经收录进本地库"
        addedLibNames = new Set(
          d.recipes.filter((r) => r.sourceUrl || r.fromWeb).map((r) => r.name)
        );
        render();
      }
    })
    .catch(() => {});

  const grid = document.getElementById('resultGrid');
  const syncToggleText = (e) => {
    const text = document.querySelector(`[data-bs-target="#weakGrid"] .weak-toggle-text`);
    if (text && e.target.id === 'weakGrid') {
      text.textContent = e.type === 'shown.bs.collapse' ? '收起' : '展开';
      weakOpen = e.type === 'shown.bs.collapse';
    }
  };
  grid.addEventListener('shown.bs.collapse', syncToggleText);
  grid.addEventListener('hidden.bs.collapse', syncToggleText);

  // 分类 Tab / 分页按钮：事件委托，点击后更新状态并重绘
  grid.addEventListener('click', (e) => {
    // 加入菜谱库（把全网检索到的真实菜谱收录进本地库）
    const addBtn = e.target.closest('.add-lib-btn');
    if (addBtn) {
      addBtn.disabled = true;
      addBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 收录中…';
      const name = addBtn.dataset.addlib;
      const found = aiExtra.find((x) => x.recipe.name === name);
      const rec = found && found.recipe;
      if (!rec || !rec.sourceUrl) {
        alert('找不到这条结果的来源信息，请重新检索后再试。');
        return;
      }
      const payload = {
        recipe: {
          name: rec.name,
          desc: rec.desc || '',
          sourceUrl: rec.sourceUrl,
          sourceName: rec.sourceName || '',
          ingredients: [],
          seasoning: '',
          flavor: rec.flavor || {},
          avoid: [],
          steps: [],
          cookware: '',
          difficulty: '简单',
        },
      };
      fetch(`${API_BASE}/api/recipes/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
        .then((r) => r.json().catch(() => ({})))
        .then((data) => {
          if (data && data.ok) {
            addedLibNames.add(name);
            // 立即并入本地库（含来源字段），无需刷新页面即可被检索命中
            if (!serverRecipes || !serverRecipes.some((x) => x.name === name)) {
              serverRecipes = [...(serverRecipes || []), { ...rec, id: -(3000 + aiSeq) }];
            }
            render();
            alert(data.message || '已加入本地菜谱库');
          } else {
            const msg = (data && data.message) || '收录失败';
            if (/已在/.test(msg)) addedLibNames.add(name);
            alert(msg);
            render();
          }
        })
        .catch((err) => {
          alert('收录失败：' + err.message + '\n\n请确认后端已启动（start.bat）。');
          addBtn.disabled = false;
          addBtn.innerHTML = '<i class="fa-solid fa-download"></i> 加入菜谱库';
        });
      return;
    }

    // 收藏 / 做一次（菜谱账本）
    const favBtn = e.target.closest('.ledger-fav');
    if (favBtn) {
      const name = favBtn.dataset.fav;
      toggleFav(name);
      refreshFavUI(name);
      renderLedger();
      return;
    }
    const cookBtn = e.target.closest('.ledger-cook');
    if (cookBtn) {
      const name = cookBtn.dataset.cook;
      cookOnce(name);
      refreshCookUI(name);
      renderLedger();
      return;
    }

    const btn = e.target.closest('[data-zone]');
    if (!btn) return;
    const zone = btn.dataset.zone;
    if (btn.hasAttribute('data-page')) {
      if (zone === 'exact') pageExact = Number(btn.dataset.page);
      else pageWeak = Number(btn.dataset.page);
      renderResults();
      return;
    }
    if (btn.hasAttribute('data-cat')) {
      const cat = btn.dataset.cat;
      if (zone === 'exact') {
        catExact = cat;
        pageExact = 1;
      } else {
        catWeak = cat;
        pageWeak = 1;
      }
      renderResults();
    }
  });

  // ---- 账本侧栏操作 ----
  document.getElementById('favList').addEventListener('click', (e) => {
    const pg = e.target.closest('[data-fpage]');
    if (pg) {
      if (pg.disabled) return;
      favPage = Number(pg.dataset.fpage);
      renderLedger();
      return;
    }
    const x = e.target.closest('[data-unfav]');
    if (!x) return;
    const name = x.dataset.unfav;
    toggleFav(name);
    refreshFavUI(name);
    renderLedger();
  });

  document.getElementById('cookList').addEventListener('click', (e) => {
    const pg = e.target.closest('[data-cpage]');
    if (pg) {
      if (pg.disabled) return;
      cookPage = Number(pg.dataset.cpage);
      renderLedger();
      return;
    }
    // 悬停 −1：撤销一次
    const dec = e.target.closest('[data-dec]');
    if (dec) {
      changeCook(dec.dataset.dec, -1);
      refreshCookUI(dec.dataset.dec);
      renderLedger();
      return;
    }
    // 点方块本体 = 再记一次（不再放常驻按钮，杜绝误触）
    const tile = e.target.closest('.cook-tile');
    if (tile) {
      const name = tile.dataset.cookTile;
      cookOnce(name);
      refreshCookUI(name);
      renderLedger();
    }
  });

  document.getElementById('ledgerResetBtn').addEventListener('click', () => {
    if (!confirm('确定清空全部收藏与烹饪记录吗？此操作不可恢复。')) return;
    resetLedger();
    renderResults();   // 重建卡片上的星标/次数
    renderLedger();
  });

  // ---- 每日菜谱推荐：AI 结合季节气候 + 账本口味生成 ----
  // 节日特供选择
  const festivalBox = document.getElementById('festivalChips');
  if (festivalBox) {
    festivalBox.addEventListener('click', (e) => {
      const chip = e.target.closest('.fest-chip');
      if (!chip) return;
      const name = chip.dataset.festival;
      selectedFestival = selectedFestival === name ? '' : name; // 再点一次取消
      festivalBox.querySelectorAll('.fest-chip').forEach((c) => {
        c.classList.toggle('on', c.dataset.festival === selectedFestival);
      });
      const tip = document.getElementById('dailyResult');
      if (tip) {
        tip.innerHTML = selectedFestival
          ? `<div class="daily-tip" style="margin-top:0">已选“${escapeHtml(selectedFestival)}”特供，点下方按钮生成节日菜单</div>`
          : '';
      }
    });
  }

  const dailyBtn = document.getElementById('dailyBtn');
  if (dailyBtn) {
    dailyBtn.addEventListener('click', async () => {
      const box = document.getElementById('dailyResult');
      const ctx = buildDailyContext();
      dailyBtn.disabled = true;
      dailyBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> AI 生成中…';
      box.innerHTML =
        '<div class="daily-loading"><i class="fa-solid fa-spinner fa-spin"></i> AI 正在结合今天的季节气候与你的菜谱账本生成菜单…</div>';
      try {
        const resp = await fetch(`${API_BASE}/api/daily`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...(ctx || { taste: {}, topIngredients: [], topDishes: [], hasRecord: false }),
            hasRecord: Boolean(ctx),
            avoids: [...state.avoids],
            maxTime: state.maxTime,
            festival: selectedFestival,
            count: 3,
          }),
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          throw new Error(err.detail || `HTTP ${resp.status}`);
        }
        const data = await resp.json();
        renderDailyResult(data);
      } catch (e) {
        box.innerHTML =
          '<div class="daily-error"><i class="fa-solid fa-circle-exclamation"></i> 生成失败：' +
          escapeHtml(e.message) +
          '<br><span>请确认后端已启动（start.bat），且 backend/.env 已配置 LLM_API_KEY（Agnes）。</span></div>';
      } finally {
        dailyBtn.disabled = false;
        dailyBtn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> 生成今日菜单';
      }
    });
  }

  // ---- 悬浮按钮：账本 / 每日推荐 展开收起 ----
  const closeFloatPanels = () => {
    document.querySelectorAll('.float-panel').forEach((p) => p.classList.remove('open'));
  };
  document.querySelectorAll('.dock-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const panel = document.getElementById(btn.dataset.toggle);
      if (!panel) return;
      const wasOpen = panel.classList.contains('open');
      closeFloatPanels();
      if (!wasOpen) panel.classList.add('open');
    });
  });
  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      document.getElementById(btn.dataset.close)?.classList.remove('open');
    });
  });
  // 收起只走三个入口：再点悬浮按钮 / 面板头部 ↓ / 按 Esc。
  // 注意不要加“点击外部任意处收起”——那样点页面其他按钮会把面板误关。
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeFloatPanels();
  });
});
