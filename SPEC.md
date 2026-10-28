# Claude × DeepSeek 桌宠 · 构建契约（SPEC v1）

> 本文件是本任务唯一事实来源。所有实现文件必须与本文一致；有冲突先问 Lead，不要自行改契约。

## 1. 目标与用户原话

用户原话（要点）：

1. 用视频 `C:\Users\LY134\OneDrive\桌面\素材.mp4` 里的形象：**Q 版 Claude（橘发少女，画面左）与 DeepSeek（蓝发少女，画面右）**，
   找到他俩的**完整形象**作为桌宠的整体形象，左 Claude、右 DeepSeek。
2. **每隔 5 秒**，右边的 DeepSeek 就伸舌头舔 Claude，**持续 3 秒**。
3. 当任务需要用户确定 / 需要授权时：**Claude 说「盐津虾嘛」**，这句话放在 Claude 上方的一个**对话框**里；
   同时 DeepSeek 伸舌头舔 Claude 3 秒；**声音类似视频开头**（用视频开头那句原声）。
4. 任务完成时：**仿照 Claude 的声音说「任务完成了」**。

视频事实（已核）：18.07s、940×540、30fps、带抖音水印与鱼眼暗角；开头 0.2–2.0s 是 Claude 说「盐津虾嘛」，
2.0–3.0s 是 DeepSeek 舔 Claude 的脸；画面只到大半身，**没有全身** —— 所以「完整形象」由我们按视频画成 Q 版全身坐姿
（已提取关键帧与参考图，见 §3.0）。

## 2. 交付形态

与 `.dsh-cat-pet/cat-pet-plugin`、`.dsh-kun-pet/kun-pet-plugin` 相同的 **profile bundle**：

- 包目录：`D:\plugging\.dsh-duo-pet\duo-pet-plugin\`
- 包名：`@local/dsh-duo-pet`；插件行 id：`duo-pet`
- Web 端在 `shell.overlay` 槽位渲染「左 Claude + 右 DeepSeek」两个 Q 版少女，**默认停在窗口底部居中**（不挡左下角 cat-pet、右下角 kun-pet），可拖动、位置记忆。
- 不是独立 HTML、不是图片交付、不新开端口、不启动第二个服务器、不改 `/cat-pet` 与 `/kun-pet` 路由。

## 3. 文件与写入范围

| 路径 | 归属 | 内容 |
|---|---|---|
| `.dsh-duo-pet/art/**` | art-master | 参数化绘制脚本、预览图 |
| `.dsh-duo-pet/duo-pet-plugin/assets/spritesheet.png`、`duo-pet-plugin/icon.png` | art-master | 精灵图、图标 |
| `.dsh-duo-pet/duo-pet-plugin/assets/sally.mp3`、`assets/done.mp3` | Lead（已产出） | 两段音效 |
| `.dsh-duo-pet/duo-pet-plugin/` 其余文件（package.json、cordis.patch.yml、index.js、client.js、locale/*.json、README.md） | plugin-engineer | 插件代码 |
| `.dsh-duo-pet/dev/**` | qa-verifier | 独立验收脚本与报告 |
| `.dsh-duo-pet/SPEC.md`、`ref/**` | Lead | 契约、参考图 |

不要修改 `.dsh-cat-pet/`、`.dsh-kun-pet/`（只读参考），不要改 profile 文件，不要调用 `plugin_manager`（安装由 Lead 做），
不要启动服务器/浏览器。

## 3.0 已备好的素材与参考

- 视频抽帧：`D:\plugging\_tools\video\full\*.png`（940×540，30fps；关键帧 0060/0180/0285/0300/0320）。
- 裁切参考图与调色板：`D:\plugging\.dsh-duo-pet\ref\`。
- 已产出的音效（engineer/qa 只读）：
  - `assets/sally.mp3`：视频开头 Claude「盐津虾嘛」原声，1.88s，约 -10.4 LUFS，128kbps。
  - `assets/done.mp3`：女声 TTS「任务完成了」升调处理，1.72s，约 -10.9 LUFS，128kbps。

## 4. 精灵图契约（Lead 与 art-master 共同保证；engineer 只消费，不改数字）

`assets/spritesheet.png`：PNG RGBA，**单元格 440 × 480 px**，**12 列 × 5 行**（整图 **5280 × 2400**）。

### 4.1 行 = 动作，帧从左到右连续；未使用格必须 alpha 全 0

| row | action | 帧数 | 列 |
|---|---|---|---|
| 0 | `idle` | 8 | 0-7（8-11 透明） |
| 1 | `snuggle` | 帧 0-11 | 0-11 |
| 2 | `snuggle` | 帧 12-23 | 0-11 |
| 3 | `snuggle` | 帧 24-35 | 0-11 |
| 4 | `done` | 12 | 0-11 |

snuggle 是 36 帧横跨三行：**第 i 帧（i=0..35）→ row = 1 + floor(i/12)，col = i % 12**。

### 4.2 帧时长（ms，client 里必须逐字一致）

```
idle:  8 帧 × 250  = 2000ms
snuggle: 36 帧 × 83 = 2988ms
done:  12 帧 × 100 = 1200ms
```

### 4.3 画面内容与像素约束（v6：抠图 1:1 版，用户确认「一模一样」路线）

- **角色像素直接来自参考截图抠图**，不重绘：Claude 来自 `ref/claude_lolita_ref.jpg` 的全身抠图，DeepSeek 来自
  `ref/deepseek_maid_ref.jpg` 的全身抠图（两图均来自用户提供的抖音截图）。抠图只允许做背景清理/瑕疵修补/边缘羽化
  （去玻璃杯吸管、去残留背景、修补鞋袜半透明），不得改写角色造型。
- **站姿全身**：两人同框并排、均可见完整头发/服装/腿/鞋；比例与参考图一致（Claude ≈2.4 头身、DeepSeek ≈2.3 头身）。
- 构图：Claude 中心 x≈120、DeepSeek 中心 x≈320；各自高度 ≈380-400px；脚下基线 y≈445；两人之间留 8-16px 空隙、
  互不遮挡；每人一个柔和椭圆地面阴影。
- 实心像素（alpha > 16）不得贴边：bbox 必须落在 `x∈[6,434]`、`y∈[6,474]` 内。
- 每帧实心像素覆盖率 > 1.5%；同一行相邻帧不得完全相同。
- 动画只允许对抠图做**平移/旋转/缩放（可轻微挤压）+ 少量叠画**（舌头、爱心、星星、地面阴影），不做重绘：
  - idle 8 帧：呼吸起伏 ±3px + 轻微摆动/旋转 ±0.6°；首帧 = snuggle 末帧。
  - snuggle 36 帧（2026-10-28 最终需求：两人贴贴 + 中间爱心）：0-0.6s 两人互相靠近（Claude 右倾 5-8° 右移 15-25px；DeepSeek 左倾 5-8° 左移 15-25px），0.6-2.3s 头/脸颊贴在一起并轻微呼吸摇晃、两人头部中间/上方冒出 2-3 颗小爱心（上浮/缩放循环），2.3-3.0s 分开回 idle；不舔、不摸头、不出现舌头/手，身体直立、脚落地、无穿模；
    **粉色小舌头（25-35px、圆尖）**贴 Claude 右脸颊（不过中线）；0.9–2.4s 舌头小幅摆动 + Claude 轻微后仰/抖动
    + 2-3 颗爱心上浮；2.4–2.8s 收舌回正；2.8–3.0s 回 idle。
  - done 12 帧：两人小跳（8-12px）+ 轻微旋转 + 星星/闪光，末 2 帧回 idle 姿态。
- 风格：与参考图一致的 3D 渲染插画质感（直接使用抠图像素），不描边、不做扁平化。

### 4.4 图标

`duo-pet-plugin/icon.png`：256 × 256 PNG RGBA，两角色头像并排，同渲染器直出，≤ 256 KiB。

## 5. 动画语义（client 必须实现；时间从「动作开始」计）

1. **自动循环（2026-10-28 需求变更：不再舔）**：`idle` 播 2.0s → `snuggle`（Claude 与 DeepSeek 贴贴 + 爱心）播 3.0s → 回 `idle`，如此循环 = **每 5s 贴贴 3s**。挂载即开始。
2. **需要用户确定/授权**（Host `waitingSeq` 增大）：
   - 立即播放 `sally.mp3`（2026-10-28 起为用户提供的人声，约 2.2s；`done.mp3` 也已换成同一段人声）；
   - 在 Claude 头顶上方显示对话框，文本 = `bubble.sally`（中文「盐津虾嘛」）；
   - 立即从第 0 帧播放一次 `snuggle`（3s，覆盖当前 idle/snuggle，不覆盖正在播的 done）；
   - 气泡可见时长：至少 4.5s；`waiting > 0` 期间保持；等待结束后 1.2s 消失；上限 8s。结束后回到正常 5s 循环。
3. **任务完成**（Host `celebrateSeq` 增大）：
   - 播放 `done.mp3`（若该 URL 为 null，则回退到浏览器 `speechSynthesis` 说「任务完成了」，`lang='zh-CN'`、`pitch≈1.5`、`rate≈1.05`，全部 try/catch）；
   - 对话框显示 `bubble.done`（中文「任务完成了」）约 2.8s；
   - 播放一次 `done` 动作（1.2s），播完回正常 5s 循环。
4. **点击宠物**（非拖动）：解锁音频；立即播一次 `snuggle`（若当前不是 done）。
5. 优先级：`done` > 等待/点击触发的 `snuggle` > 自动循环；同一动作播放中收到同类触发只重新开始，不叠加。
6. 挂载后首次拿到 Host 状态时，把 `waitingSeq` / `celebrateSeq` 记为基线，**不为历史事件补播**。
7. 计时器/监听全部在 React effect cleanup 与 ctx.effect 中释放；组件卸载后不得再 setState。

## 6. Host 半 `index.js`

```js
export const inject = ['webServer']
export function apply(ctx) { /* ... */ }
```

- 读素材（`node:fs`，相对 `import.meta.url`）：`assets/spritesheet.png`、`assets/sally.mp3`、`assets/done.mp3`；
  任一读取失败只 `console.error('[duo-pet] ...')`，不得让 Host 抛错；对应 URL 在 state 里为 `null`、路由不注册（404）。
- 状态机（进程内，多 session 全局）：
  - `mode: 'idle' | 'working' | 'waiting'`；`waiting>0` → `waiting`；否则有 running agent → `working`；否则 `idle`。
  - `seq`：任意可观察变化（mode 变、waitingSeq 变、celebrateSeq 变）自增。
  - `waitingSeq`：每次新的「等待用户」开始 +1；`celebrateSeq`：每次「有 agent 从 running 变 idle 且该 agent 没报错、
    无其他 running agent、waiting===0」+1。
  - 事件（必须都监听，并容错 payload 形状）：
    - `ctx.on('agent/status', ({agent, status}) => ...)`：running/idle 记账；running→idle 满足条件时 celebrate。
    - `ctx.on('agent/error', ...)`：把 agent 记入 errored 集合（其后的 idle 不 celebrate）。
    - `ctx.on('approval/request', (request, next) => ...)`：**waterfall**，必须先 `waiting++`、`waitingSeq++`，
      再调用 `next()`，并在 settle（成功或失败）后 `waiting--`；不得吞掉/改变返回的 Promise。
    - `ctx.on('user-questions/request', (request, next) => ...)`：同上（用户确认类问题同样触发「盐津虾嘛」反应）。
  - 兼容兜底：每 500ms 用 `ctx.get('agents')?.list()` 读 `.status` 校准；`ctx.effect` 清理 interval 与所有路由
    （与 `.dsh-kun-pet/kun-pet-plugin/index.js` 的写法一致，可直接借鉴其结构）。
- HTTP 路由（全部 `webServer.register({ kind: 'exact', ... })`，经 `ctx.effect` 清理；query 不参与匹配）：
  - `GET /duo-pet/state` → `application/json; charset=utf-8`、`Cache-Control: no-store`，body：
    ```json
    { "mode": "idle", "seq": 0, "waitingSeq": 0, "celebrateSeq": 0,
      "waiting": 0, "running": 0, "revision": 2,
      "spriteUrl": "/duo-pet/spritesheet.png?rev=2&h=<mtimeMs>-<size>",
      "sallyUrl": "/duo-pet/sally.mp3", "doneUrl": "/duo-pet/done.mp3",
      "hits": { "state": 0, "sprite": 0 } }
    ```
    素材缺失时对应 URL 为 `null`。
  - `GET /duo-pet/spritesheet.png` → `image/png`，`Cache-Control: public, max-age=86400`，`Content-Length` 正确。
  - `GET /duo-pet/sally.mp3` → `audio/mpeg`，同上缓存头。
  - `GET /duo-pet/done.mp3` → `audio/mpeg`，同上缓存头。
- 不要注册 `/duo-pet/meta.json`，不要写任何非上述路由。

## 7. Client 半 `client.js`

### 7.1 模块外壳（照抄 cat-pet 的加载器约定）

```js
window.__ModuleLoader__.load({
  id: '@local/dsh-duo-pet',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    /* ... */
    return { inject: ['slots', 'locale', 'timer'], apply(ctx) { /* ... */ }, _internals: { ANIMATIONS, frameFor, durationsOf } }
  },
})
```

- factory 顶层无副作用（不 fetch、不读 localStorage、不建计时器）。
- `apply(ctx)`：注册 locale（`ctx.effect(() => locale.register('duo-pet', 'zh', zhDict))` 同 en），
  然后 `ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'duo-pet', order: 120, label: () => translate('meta.title') }, DuoPet))`。
- `_internals` 供 QA 断言帧表：`ANIMATIONS`（含每行帧数与时长）、`frameFor(action, i)` 返回 `{row, col}`、
  `durationsOf(action)` 返回时长数组（idle 8×250 / snuggle 36×83 / done 12×100）。
- `ctx.slots`/`ctx.locale` 缺失时 console.error 并安全退出，不得抛错。

### 7.2 尺寸与渲染

- `CELL=440, COLS=12, ROWS=5, SCALE=0.65` → 页面显示 **286 × 312**（第二版按用户反馈「好高」缩小）。
- 精灵图 div：`background-size: 3432px 1560px`，`background-position: -(col*286)px -(row*312)px`，`background-repeat: no-repeat`。
- 宠物根节点：`position: fixed; z-index: 1000; pointer-events: auto`；默认位置 = 底部居中、悬浮在输入卡上方（避开输入框）：
  `left = max(0, (innerWidth-286)/2)`、`top = max(0, innerHeight-312-170)`；窗口 resize 时 clamp 回可视区。
- 拖动：pointerdown 记录，移动 > 6px 进入拖动；pointerup 存 `localStorage['dsh.duo-pet.pos']`（`{left,top}`，try/catch；
  坏数据回退默认）；拖动结束不触发点击。`touch-action: none`。
- 图片加载失败：显示 emoji 兜底（如 `🧡💙`），不白屏、不抛错。

### 7.3 状态轮询与触发

- 挂载后立即 fetch `/duo-pet/state`，然后每 **500ms** 轮询一次（`cache: 'no-store'`，用 ctx.interval / cleanup 释放）。
- 首帧拿到状态时记基线；随后：
  - `waitingSeq > lastWaitingSeq` → 触发 §5.2；
  - `celebrateSeq > lastCelebrateSeq` → 触发 §5.3；
  - 用 `waiting`（>0 保持气泡）与 `spriteUrl/sallyUrl/doneUrl`（可能变化）更新渲染。
- fetch 失败：保留上一次状态继续跑动画（不崩、不白屏）。

### 7.4 气泡

- 绝对定位在宠物上方、水平对准 Claude 的头顶（约宠物宽度的 28%）：`position:absolute; bottom:100%;
  left: 43px; margin-bottom: 6px;`，白色圆角、细边、软阴影、`pointer-events:none`、小三角指向下方（tail `left: 48px`）；
  max-width 200px；
  `font: 13px/1.45 system-ui, "Microsoft YaHei", sans-serif`；深色主题下白底深字可读。
- 文本取 locale：`bubble.sally` / `bubble.done` / `bubble.hint` / `bubble.dragging`；无文本时气泡不渲染。
- `<style>` 内选择器必须以 `.duopet-` 前缀，不得覆盖全局样式。

### 7.5 音频

- 两个 `<audio>`（或 Audio 对象）分别对应 `sallyUrl`、`doneUrl`；URL 为 null 时禁用对应声音（done 例外：回退 speechSynthesis）。
- 播放前 `currentTime = 0`，`play()` 的 Promise catch 掉；浏览器自动播放限制时，把待播声音挂起，
  在首次 window `pointerdown`/`keydown`（用户手势）后补播；同一时间只播一个声音。
- 声音文件只能从 Host 路由取，不得内联 base64（保持包体积）。

### 7.6 无障碍与生命周期

- 根节点 `role="button"`、`tabIndex=0`、`aria-label`/`title` = 本地化 `meta.title`；Enter/Space 等同点击。
- 所有计时器、监听、动画、音频在 cleanup 释放；`prefers-reduced-motion` 下保留动作但可去掉额外 translate 动效。

## 8. 本地化与包清单

- `locale/zh.json` / `locale/en.json`：
  ```json
  { "meta": { "title": "Claude × DeepSeek 桌宠", "description": "..." },
    "bubble": { "sally": "盐津虾嘛", "done": "任务完成了", "hint": "点我一下嘛～", "dragging": "别拖我啦～" } }
  ```
  en 同结构（`sally` 可用 `"Yánjīn xiā ma!"`，`done`: `"Mission complete!"`）。client 内字典与 JSON 内容必须一致。
- `package.json`：`name: "@local/dsh-duo-pet"`、`version: "1.0.0"`、`private: true`、`type: "module"`、`main: "index.js"`、
  `icon: "icon.png"`、`exports` 含 `"."`、`"./client"`、`"./locale/*.json"`、`"./icon"`、`"./package.json"`；
  `files` 覆盖 index.js、client.js、cordis.patch.yml、icon.png、locale/*.json、assets/spritesheet.png、
  assets/sally.mp3、assets/done.mp3、README.md；`dsh.bundle.patch: "./cordis.patch.yml"`；
  `dsh.client: { "platform": "web", "immediately": true, "inject": ["@deepseek-ai/dsh-client-ui-layout"] }`；`license: "MIT"`。
- `cordis.patch.yml`：只插入本行，不覆盖其它行：
  ```yaml
  - insert:
      - id: duo-pet
        name: '@local/dsh-duo-pet'
  ```
- `README.md`：用途、5s/3s 规则、授权与完成反应、素材契约、安装/卸载（`plugin_manager install_bundle` / 移除）、限制
  （浏览器自动播放手势限制；声音来源：视频原声 + TTS）。

## 9. 约束

- 视频原文件不要拷贝进包内；不要新增第三方依赖；纯 ESM + React（由 loader 注入）。
- 所有 JS 用 `node --check`；JSON 用 `JSON.parse`；YAML 人工按模板核对。
- 不得创建预览 HTML / mock 页面 / 截图脚本 / 光栅化工具来“验证”插件外观（素材自检除外：art 侧的 PIL 断言由 Lead 负责）。
- 无浏览器控制权：验证仅限 JS 语法、manifest、Host 假 ctx 行为、Client 注册与 `_internals` 帧表、素材字节/尺寸、音效可解析。
- 完成或阻塞时给 Lead 发消息（`send_message` target `lead`），带文件清单 + 自检结果 + 未决问题。

## 10. 验收清单（QA 独立执行，不看 engineer 自测结论）

1. `node --check index.js client.js`；`JSON.parse` package.json 与 locale；patch 只 insert `duo-pet` 一行且包名一致。
2. Host 假 ctx：收集事件监听与路由；断言
   (a) `approval/request` / `user-questions/request` 触发 waiting/ waitingSeq 变化且 settle 后回落；
   (b) `agent/status` running→idle 触发 celebrateSeq 且 `agent/error` 后不触发；
   (c) `/duo-pet/state` 字段类型与 URL 形状；`/duo-pet/spritesheet.png`、两个 mp3 的 Content-Type 与字节数
   （必须与文件字节完全一致）；(d) `ctx.effect` cleanup 后路由与 interval 均被注销。
3. Client 假 loader：断言 `id`、`inject`、注册的 `name/id/order/label`、组件为函数；`_internals.ANIMATIONS` 帧数/行映射
   与时长之和 = 2000/2988/1200；factory load 时无 fetch/interval 调用。
4. 素材：spritesheet 5280×2400；row0 col0-7、row1-3 col0-11、row4 col0-11 每帧 alpha 覆盖 > 1.5%；未用格 alpha 全 0；
   实心像素 bbox 不贴边；icon 256×256、≤256KiB；两个 mp3 可被解析（ffprobe 或 magic + 时长）。
5. locale 中英 `meta.title/description` 与 4 个 `bubble.*` 齐全非空；package `exports`/`files` 覆盖所有运行时文件。
6. 报告：逐项 PASS/FAIL + 证据（命令输出/关键数值）；失败指出文件与行号；不要改包文件，失败反馈给 Lead。
