# 设计方向笔记（cf-gh-proxy 首页重做）

## idea 句

> On this page, **一条 302 链被 Worker 自己跟完的直角转折** becomes **the chevron**。

上游的做法是把 `302` 回写给客户端（客户端再请求一次 Worker），所以 90 秒才断在 20798 字节。
本项目的实质是「把这条链在边缘跟完」——链、箭头、直角转折是这个产品独有的几何，
不是从品类里借来的装饰。所以母题取 **chevron（一个直角转折的箭头）**，
不用卡片网格、不用渐变、不用圆角矩形阵列。

## motif 的三四个尺度

| 尺度 | 位置 |
| --- | --- |
| 96px | hero 那块饱和色平台的左上角，用 `clip-path` 切出一个直角缺口 |
| 64px | 黑色通栏带的左边缘，同一个缺口 |
| 20px | 「它跟的那条链」四段之间，每一跳一个 chevron |
| 11px | 路径表每一行行首的箭头 |

## 字体：为什么不是 League Spartan

skill 抽到的 display 面是 League Spartan（Google Fonts）。
**本项目的硬约束是零外部资源**（`test/pages.test.js` 第 2 条断言：首页 `src=`/`href=` 不许出现外部地址），
这条约束不是审美选择，是「一个 HTML 就是全部、能被边缘缓存、不产生额外请求、不受第三方可用性影响」。
把字体嵌成 base64 又会把页面从 ~30KB 涨到几百 KB，与用户「性能一定要好」的要求直接冲突。

→ **降级**：display 用系统无衬线栈，靠 700 字重 + `-0.035em` 字距 + `0.9` 行高做出同等的紧凑几何感；
text 用同一个栈的 400/600。这是「与既定品牌约束冲突」的正当重绘，在报告里写明。

同理，skill 要求「页面上至少四张真实图片」，而本项目没有截图、也不许引外部图床
→ 按 direction sheet 自己给的替代方案：「软件的图就是它自己的界面」，
用真实 HTML 界面片段（根节点标 `data-ui`），不用假仪表盘灰条、不用设备边框。

## palette

```css
--bg:#ffffff;      --surface:#f2f2f2;  --ink:#0a0a0a;  --muted:#6b6b6b;
--accent:#d92b21;  --accent-ink:#ffffff;
--band-bg:#000000; --band-ink:#ffffff;
```
白色地面 + paper grey 的实色块 + **一个全黑通栏带**；signal red 只出现在按钮、
一个词、和 hero 那块平台上。**没有渐变**（原来那层 `radial-gradient` 的 hero 删掉，skill 明令禁止）。

暗色：地面 `#0b0b0b`、paper `#171717`、ink `#f2f2f2`、accent 提亮到 `#ff5a4e`（保持对比度）。

## live thing（页面上能真做的事）

两件，都是真的：
1. **hero 平台上就是那个输入框本身**（`data-ui` 片段，不是示意图）：粘链接 → 问 `?check=` → 跳转。
2. **cta 那句句子里嵌一个 `input`**：填你自己的 Worker 域名，下面实时拼出你自己的加速地址。

## 分区（按 direction sheet 的顺序）

1. **hero** — Fragment on a shaped stage
2. **features** — Close-ups on a board（8 块马赛克，每块放一个被放大的真实界面元素）
3. **how-it-works** — One card, four fields（同一个文件卡片，四段越走越远：90s 断掉 → 1.07s 拿完）
4. **proof** — Large marks on tiles（三个实测数字）
5. **list** — The printed menu sheet（支持的路径，像一张印刷的菜单）
6. **cta** — A sentence with a blank

## 两条 blueprint 与本页的冲突（已按 house rules 优先解决）

- features 蓝图写 10px 字 → house rule 最小 13px，用 13px。
- cta 蓝图把句子设到 6vw → 会被判卷当成长标题，压到 `clamp(24px,3.2vw,40px)` 两到三行。
