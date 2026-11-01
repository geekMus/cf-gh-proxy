# 设计方向笔记（cf-gh-proxy 首页）

最后一版是**单屏工具页**：标题一句话、下面一条输入栏、页脚一行仓库地址。不滚动，不讲原理。

## idea 句

> 这一屏只做一件事：**把地址丢进去，直接从我们的链接下**。

用户三次否掉了「讲原理的落地页」（302 追踪图、路径表、实测数字、域名 CTA），理由一致：
他要的是「粘链接就能下」，不是一份产品介绍。所以页面上只留**一个主角**——输入栏；其余全部让位。

## 布局

```
顶栏  logo · GitHub 文件加速                                  主题按钮
                     GitHub 文件，一条更快的链接
        把 release 资产、源码包或单个文件的地址丢进去，走这条链接直接下
   ┌───────────────────────────────────────────────────┐
   │  https://github.com/owner/repo/releases/download/… │  加速 →
   └───────────────────────────────────────────────────┘
        试试   release 资产   源码包   单个文件   复制示例
页脚                  github.com/geekMus/cf-gh-proxy · MIT
```

- `.shell{min-height:100svh;flex column}`，中间 `.stage` 吃掉剩余高度并居中：1440×900 与 390×844 都是**恰好一屏**，不出滚动条。
- 标题与说明在输入栏**上方**（上下排布），没有左右分栏——这是用户明确要求的。
- 顶栏没有导航锚点：这一屏没有可跳的分区，留锚点只会让人以为下面还有东西。

## 输入栏为什么是一个整体

两个并排的方框看起来像两个东西；输入框和按钮在视觉上应该是**同一条**。

```css
.bar{display:flex;align-items:center;gap:6px;padding:6px;
     background:var(--field);box-shadow:inset 0 0 0 1px var(--surface-2)}
.bar:hover{box-shadow:inset 0 0 0 1px var(--muted)}
.bar:focus-within{box-shadow:inset 0 0 0 2px var(--accent)}
```

- 描边用 `box-shadow:inset` 而不是 `border`：边框占宽度，换色时整行会跳。
- `#q` 自身透明无边框，`#go` 是嵌在右端的强调色块；聚焦时整条描边变亮变粗，而不是只亮输入框。
- ≤640px 改成上下两行（输入框一行、按钮通栏），`#q` 48px / 16px 字防止 iOS 缩放。

## 示例行为什么不是方框

这一屏只该有一个「有边框的主角的」。四个带框的小卡片会把视线从输入栏抢走。所以示例是
**安静的文字按钮**：13px、带下划线（`text-decoration-color` 用最浅的 surface-2），hover 才变强调色；
`复制示例` 单独一枚带图标、无下划线。行首一个 `试试` 标签承担说明，不用 eyebrow。

## 配色

```css
亮  --bg:#f6f8fb  --surface:#eef1f6  --field:#ffffff  --ink:#1b2634  --muted:#5b6b7c  --accent:#2f6f9f
暗  --bg:#101519  --surface:#171d24  --field:#0b1014  --ink:#e2e9f0  --muted:#93a2b3  --accent:#7fb4d4
```

- 不用纯黑纯白：亮色地面是偏蓝的灰白，暗色是带蓝的墨色，长时间看不刺眼。
- 单一强调色（青蓝）。按钮、聚焦描边、链接 hover 都用它，不出现第二种彩色。
- 实测对比度（两套都测）：标题 14.4 / 15.0、说明 5.1 / 7.1、按钮字 5.4 / 8.5、输入框字 15.3 / 15.6，全部过 AA。
- **网格背景**是两层 SVG data URI（32px 细线 opacity .052 + 128px 主线 .075），`body::before{position:fixed}`。
  不用 CSS 渐变——house rule 明令禁止，而且渐变网格在暗色下会泛出光晕。

## 标志

一枚**直角转折箭头**（`M5 8.5h10v9h3` + 箭头三角，stroke-width 4，viewBox 32）：它就是 302 链在边缘拐弯走完的动作。
16px 下是一块粗壮实心图形，不会糊成灰点。顶栏只画 accent 色的线，不用色块底；
favicon 用同一几何，换 `#2f6f9f` 底色 + 白色描边，由 Worker 直接以 `image/svg+xml` 返回。

## 为什么没有 webfont（inspector 的唯一 FAIL，显式放行）

`inspect.mjs --app` 判 `[font-not-dealt]`：素材单抽到 League Spartan / Figtree，而页面渲染 `-apple-system`。

**这是约束冲突，不是偷懒**：`test/pages.test.js` 断言首页 `src=`/`href=` 里不许出现外部地址，
零外部资源是这个产品的卖点（一个 HTML 就是全部、能被边缘缓存、不受第三方可用性影响）。
把字体 base64 内嵌会把 19.8 KB 的首页撑到几百 KB，与「性能一定要好」直接冲突。

→ 用 `--allow font-not-dealt` 放行，正文用系统栈（`-apple-system` 这一串），靠字重与字距做紧凑感。

## inspector 结果（app 模式）

`node inspect.mjs http://127.0.0.1:8800/ --app --allow font-not-dealt`

- **0 FAIL / 0 WARN**，`page 1 screens`，h1 一行（32px；@768 24px，@390 23px），字号档位 13 / 15 / 16 / 32。
- 单屏工具页在 `--app` 下本来就不判 `few-pictures` / `still-page` / `off-centre` / `name-only-title` / `small-text`
  （`rules.mjs` 的 `APP_SKIP`）——这一屏的形态就是「一个输入框 + 一个按钮」，没有「客户的世界」可拍。
- 动效：`.anim` 按 50ms 递进浮入（标题 → 说明 → 输入栏 → 示例行），`prefers-reduced-motion` 全关。
  没有滚动，也就没有滚动触发的东西——所以 `still-page` 不适用。

## 被否掉的旧方向（留档，别再回去）

- 白底 + paper grey + 全黑通栏 + signal red `#d92b21` 的四段式落地页（302 追踪、路径表、三个数字、域名 CTA）。
- 把「上一版」的对比、其他项目的名字写进页面——用户要求本页只代表本仓库。