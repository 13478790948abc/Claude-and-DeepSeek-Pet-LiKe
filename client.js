// =============================================================================
// Claude × DeepSeek 桌宠 · Client 半
//
// 在 `shell.overlay` 里渲染「左 Claude + 右 DeepSeek」两个 Q 版少女：
//   - 精灵图契约（SPEC §4）：单元格 440×480，12 列 × 5 行，0.65 倍显示 = 286×312。
//     idle row0 8 帧×250ms；snuggle（两人贴贴）横跨 row1-3 共 36 帧×83ms；done row4 12 帧×100ms。
//   - 自动循环（SPEC §5.1）：idle 2.0s → snuggle 3.0s → idle，即每 5s 贴贴 3s。
//   - 需要用户确定/授权（Host waitingSeq 增大）：气泡「盐津虾嘛」+ 用户提供的授权人声 + 立刻一次 snuggle。
//   - 任务完成（Host celebrateSeq 增大）：done.mp3（缺失则 speechSynthesis）+ 气泡 + done 动画。
//   - 每 500ms 轮询同源 /duo-pet/state；可拖动、位置记忆、音频解锁、emoji 兜底（精灵图加载失败自动重试 3 次）。
//
// 契约：D:\plugging\.dsh-duo-pet\SPEC.md §5 / §7。factory 顶层无副作用。
// =============================================================================

window.__ModuleLoader__.load({
  id: '@local/dsh-duo-pet',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'duo-pet'

    // ---------- 精灵图契约（SPEC §4 / §7.2） ----------
    const CELL = 440 // 单元格宽（px）
    const CELL_H = 480 // 单元格高（px）
    const COLS = 12
    const ROWS = 5
    // 0.65 倍：286 × 312，比首版 330×360 更矮小圆润，减少屏幕占用（用户反馈「好高」）。
    const SCALE = 0.65
    const W = CELL * SCALE // 286 页面显示宽
    const H = CELL_H * SCALE // 312 页面显示高
    const SPRITE_WIDTH = COLS * W // 3432（background-size 宽）
    const SPRITE_HEIGHT = ROWS * H // 1560（background-size 高）
    // 两个小人在所有帧里的并集包围盒（素材实测：cell 内 alpha>16 的并集 bbox = x[9,421] y[58,457]）。
    // 交互区域就框在这里，不再是整块 286×312 的透明矩形；有气泡时再并上气泡的框。
    const PET_BOX = {
      left: Math.floor(9 * SCALE),
      top: Math.floor(58 * SCALE),
      width: Math.ceil((421 - 9 + 1) * SCALE),
      height: Math.ceil((457 - 58 + 1) * SCALE),
    }

    const STATE_URL = '/duo-pet/state'
    // 页面可见性上报：桌面悬浮层据此判断「页内是否能出声」。
    const VISIBILITY_URL = '/duo-pet/page-visibility'
    // 页内右键菜单与桌面悬浮层联动的两个 Host 接口。
    const MINIMIZE_URL = '/duo-pet/minimize'
    const OVERLAY_OPTION_URL = '/duo-pet/overlay-option'
    const DEFAULT_SPRITE_URL = '/duo-pet/spritesheet.png?rev=2'
    // 浏览器对 PNG 路由有 24h 缓存；换图后用 query 参数强制重新下载（路由按路径精确匹配，忽略 query）。
    const ART_CACHE_BUST = 'v3'
    const withArtBust = (url) => (typeof url === 'string' && url !== ''
      ? url + (url.indexOf('?') === -1 ? '?' : '&') + ART_CACHE_BUST
      : null)
    const POS_KEY = 'dsh.duo-pet.pos'
    // 默认停在「输入框上方」的底部居中位置：像坐在输入卡上沿的桌面宠物，
    // 而不是压在输入框/发送按钮上。拖动后可任意摆放并记忆。
    const DEFAULT_MARGIN = 16
    const DEFAULT_BOTTOM_OFFSET = 170 // 宠物底边距离窗口底部（避开输入卡）
    const DRAG_THRESHOLD = 6 // 超过 6px 才算拖动
    const POLL_MS = 500

    const SALLY_BUBBLE_MIN_MS = 4500 // 授权气泡至少可见 4.5s
    const SALLY_BUBBLE_MAX_MS = 8000 // 授权气泡上限 8s
    const SALLY_END_HOLD_MS = 1200 // 等待结束后 1.2s 消失
    const DONE_BUBBLE_MS = 2800 // 完成气泡约 2.8s
    const HINT_BUBBLE_MS = 4000 // 首次挂载提示

    // SPEC §4.2 帧时长表（ms，必须逐字一致）。行 = 动作，帧从左到右连续。
    const repeat = (value, count) => {
      const list = []
      for (let index = 0; index < count; index += 1) list.push(value)
      return list
    }

    const ANIMATIONS = {
      idle: { rows: [0], row: 0, count: 8, frameMs: 250, frames: repeat(250, 8) },
      snuggle: { rows: [1, 2, 3], row: 1, count: 36, frameMs: 83, frames: repeat(83, 36) },
      done: { rows: [4], row: 4, count: 12, frameMs: 100, frames: repeat(100, 12) },
    }

    // snuggle 第 i 帧 → row = 1 + floor(i/12)，col = i % 12；其余动作单行取模。
    const frameFor = (action, index) => {
      const animation = ANIMATIONS[action] || ANIMATIONS.idle
      const total = animation.frames.length
      const numeric = Number(index)
      const normalized = Number.isFinite(numeric) && total > 0
        ? ((Math.floor(numeric) % total) + total) % total
        : 0
      if (animation.rows.length > 1) {
        const rowIndex = Math.floor(normalized / COLS) % animation.rows.length
        return { row: animation.rows[rowIndex], col: normalized % COLS }
      }
      return { row: animation.rows[0], col: normalized % COLS }
    }

    const durationsOf = (action) => {
      const animation = ANIMATIONS[action]
      return animation === undefined ? [] : animation.frames.slice()
    }

    const durationOf = (action) => durationsOf(action).reduce((total, ms) => total + ms, 0)

    // 自动循环的 idle 时长直接由帧表推出（8×250 = 2000ms），保证与动画不脱节。
    const IDLE_PLAY_MS = durationOf('idle')

    // ---------- 本地化（必须与 locale/zh.json、locale/en.json 内容一致） ----------
    const zhDict = {
      'meta.title': 'Claude × DeepSeek 桌宠',
      'meta.description': '在界面底部居中显示 Claude 与 DeepSeek 的 Q 版桌宠：每 5 秒 Claude 与 DeepSeek 互相贴贴 3 秒（中间冒爱心）；需要授权时 Claude 说「盐津虾嘛」，任务完成时说「任务完成了」。可拖动、右键菜单、记忆位置。',
      'bubble.sally': '盐津虾嘛',
      'bubble.done': '任务完成了',
      'bubble.hint': '点我一下嘛～',
      'menu.snuggle': '贴贴',
      'menu.celebrate': '庆祝',
      'menu.idle': '待机',
      'menu.minimizeDsh': '最小化 DSH',
      'menu.action': '动作',
      'menu.topmost': '置顶',
      'menu.alwaysShow': '总是显示',
      'menu.closePet': '关闭桌宠',
      'menu.untopmost': '取消置顶',
      'menu.cancelAlwaysShow': '取消总是显示',
      'bubble.dragging': '别拖我啦～',
      'bubble.closed': '桌宠已关闭，刷新页面可恢复',
    }

    const enDict = {
      'meta.title': 'Claude × DeepSeek Pet',
      'meta.description': 'A chibi Claude and DeepSeek desk pet in the bottom center: every 5 seconds Claude and DeepSeek snuggle together for 3 seconds with hearts between them; when approval is needed Claude says "Yánjīn xiā ma!", and when a task finishes it says "Mission complete!". Draggable, right-click menu, position memory.',
      'bubble.sally': 'Yánjīn xiā ma!',
      'bubble.done': 'Mission complete!',
      'bubble.hint': 'Click me~',
      'menu.snuggle': 'Snuggle',
      'menu.celebrate': 'Celebrate',
      'menu.idle': 'Idle',
      'menu.minimizeDsh': 'Minimize DSH',
      'menu.action': 'Action',
      'menu.topmost': 'Always on top',
      'menu.alwaysShow': 'Always show',
      'menu.closePet': 'Close pet',
      'menu.untopmost': 'Unpin topmost',
      'menu.cancelAlwaysShow': 'Stop always-show',
      'bubble.dragging': "Don't drag me~",
      'bubble.closed': 'Pet closed — refresh the page to bring it back',
    }

    // 所有选择器都带 .duopet- 前缀，<style> 只作用于本插件节点。
    const CSS = `
.duopet-root {
  box-sizing: border-box;
  outline: none;
  /* 整块透明区域不拦鼠标（页面遮挡变小）；只有 .duopet-hit 那一小块小人的包围盒可交互。 */
  pointer-events: none;
}
.duopet-root:focus-visible {
  outline: 2px solid #7aa2ff;
  outline-offset: 4px;
  border-radius: 16px;
}
.duopet-hit {
  position: absolute;
  pointer-events: auto;
  cursor: grab;
  z-index: 1;
}
.duopet-hit:active {
  cursor: grabbing;
}
.duopet-sprite {
  position: absolute;
  left: 0;
  top: 0;
  background-repeat: no-repeat;
  image-rendering: auto;
  pointer-events: none;
}
.duopet-fallback {
  position: absolute;
  left: 0;
  top: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font: 96px/1 system-ui, "Segoe UI", "Microsoft YaHei", sans-serif;
  user-select: none;
  pointer-events: none;
}
.duopet-bubble {
  position: absolute;
  /* 气泡贴在 Claude 头顶正上方：idle/snuggle 帧里头顶约在盒顶下方 95px（0.65 倍显示），
     所以气泡底边下移到盒顶下方 ~91px、水平对正 Claude 头顶（头中心 x≈70px）。 */
  left: 25px;
  bottom: calc(100% - 91px);
  margin-bottom: 0;
  max-width: 150px;
  padding: 4px 10px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.97);
  color: #2b2b33;
  border: 1px solid rgba(214, 176, 150, 0.55);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.13), 0 1px 2px rgba(0, 0, 0, 0.05);
  font: 12px/1.35 system-ui, "Microsoft YaHei", sans-serif;
  text-align: center;
  white-space: normal;
  overflow-wrap: break-word;
  pointer-events: none;
  z-index: 2;
  animation: duopet-bubble-pop 170ms ease-out;
}
@keyframes duopet-bubble-pop {
  from { transform: translateY(3px) scale(0.94); opacity: 0; }
  to { transform: none; opacity: 1; }
}
.duopet-bubble::after {
  content: '';
  position: absolute;
  top: 100%;
  left: 45px;
  border: 6px solid transparent;
  border-top-color: rgba(255, 255, 255, 0.97);
}
.duopet-menu {
  position: absolute;
  z-index: 3;
  min-width: 96px;
  padding: 4px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.98);
  border: 1px solid rgba(214, 176, 150, 0.6);
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.18), 0 1px 2px rgba(0, 0, 0, 0.06);
  font: 12px/1.5 system-ui, "Microsoft YaHei", sans-serif;
  color: #2b2b33;
  pointer-events: auto;
  user-select: none;
}
.duopet-menu-item {
  display: block;
  width: 100%;
  padding: 4px 10px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.duopet-menu-item:hover {
  background: rgba(255, 214, 196, 0.75);
}
.duopet-menu-label {
  padding: 3px 10px 1px;
  font-size: 11px;
  color: #8a7f76;
  text-align: left;
  user-select: none;
}
.duopet-menu-sub {
  padding-left: 22px;
}
.duopet-menu-sep {
  height: 1px;
  margin: 4px 6px;
  background: rgba(214, 176, 150, 0.45);
}
.duopet-menu-parent {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.duopet-menu-arrow {
  font-size: 10px;
  color: #8a7f76;
}
.duopet-submenu {
  position: absolute;
  left: calc(100% + 2px);
  top: 28px;
  min-width: 84px;
  padding: 4px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.98);
  border: 1px solid rgba(214, 176, 150, 0.6);
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.18), 0 1px 2px rgba(0, 0, 0, 0.06);
}
@media (prefers-reduced-motion: reduce) {
  .duopet-sprite {
    transition: none;
  }
}
`

    // ---------- 位置记忆（拖拽 / resize clamp） ----------
    // 有些桌面窗口的 innerWidth/innerHeight 会比屏幕还大（窗口大于显示器时，
    // 视口底部会落到屏幕外）。定位时取「视口 ∩ 屏幕可用区域」，保证宠物始终在
    // 用户看得见的屏幕内。
    const viewportOf = () => {
      if (typeof window !== 'undefined' && window !== null) {
        let width = Number(window.innerWidth)
        let height = Number(window.innerHeight)
        try {
          const screenObject = window.screen
          if (screenObject !== undefined && screenObject !== null) {
            const availWidth = Number(screenObject.availWidth)
            const availHeight = Number(screenObject.availHeight)
            if (Number.isFinite(availWidth) && availWidth > 0) width = Math.min(width, availWidth)
            if (Number.isFinite(availHeight) && availHeight > 0) height = Math.min(height, availHeight)
          }
        } catch (error) {
          // screen may be unavailable in some embeddings; fall back to the raw viewport
        }
        if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
          return { width, height }
        }
      }
      return { width: W + DEFAULT_MARGIN * 2, height: H + DEFAULT_MARGIN * 2 }
    }

    const clampPosition = (left, top) => {
      const viewport = viewportOf()
      const maxLeft = Math.max(0, viewport.width - W)
      const maxTop = Math.max(0, viewport.height - H)
      const leftValue = Number.isFinite(Number(left)) ? Number(left) : 0
      const topValue = Number.isFinite(Number(top)) ? Number(top) : 0
      return {
        left: Math.min(Math.max(leftValue, 0), maxLeft),
        top: Math.min(Math.max(topValue, 0), maxTop),
      }
    }

    // 默认位置 = 可见屏幕内的底部居中、悬浮在输入卡上方：
    // left = max(0, (可见宽-286)/2)，top = max(0, 可见高-312-170)。
    const defaultPosition = () => {
      const viewport = viewportOf()
      return {
        left: Math.max(0, (viewport.width - W) / 2),
        top: Math.max(0, viewport.height - H - DEFAULT_BOTTOM_OFFSET),
      }
    }

    const readStoredPosition = () => {
      try {
        if (typeof localStorage === 'undefined' || localStorage === null) return null
        const raw = localStorage.getItem(POS_KEY)
        if (raw === null || raw === '') return null
        const parsed = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object') return null
        const left = Number(parsed.left)
        const top = Number(parsed.top)
        if (!Number.isFinite(left) || !Number.isFinite(top)) return null
        return clampPosition(left, top)
      } catch (error) {
        return null
      }
    }

    const saveStoredPosition = (position) => {
      try {
        if (typeof localStorage === 'undefined' || localStorage === null) return
        localStorage.setItem(POS_KEY, JSON.stringify({
          left: Math.round(position.left),
          top: Math.round(position.top),
        }))
      } catch (error) {
        // 隐私模式 / 配额满：静默回退，不抛错
      }
    }

    // ---------- Host state 归一化 ----------
    const toFiniteNumber = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
    const toCount = (value) => Math.max(0, Math.floor(toFiniteNumber(value)))
    const toUrl = (value) => (typeof value === 'string' && value !== '' ? value : null)

    const normalizeHostState = (value) => {
      const source = value !== null && typeof value === 'object' ? value : {}
      return {
        mode: typeof source.mode === 'string' ? source.mode : 'idle',
        seq: toFiniteNumber(source.seq),
        waiting: toCount(source.waiting),
        waitingSeq: toCount(source.waitingSeq),
        celebrateSeq: toCount(source.celebrateSeq),
        running: toCount(source.running),
        revision: toFiniteNumber(source.revision),
        spriteUrl: toUrl(source.spriteUrl),
        sallyUrl: toUrl(source.sallyUrl),
        doneUrl: toUrl(source.doneUrl),
        overlayTopmost: source.overlayTopmost === false ? false : true,
        overlayAlwaysShow: source.overlayAlwaysShow === true,
      }
    }

    const hostStateEquals = (left, right) => (
      left.mode === right.mode
      && left.seq === right.seq
      && left.waiting === right.waiting
      && left.waitingSeq === right.waitingSeq
      && left.celebrateSeq === right.celebrateSeq
      && left.running === right.running
      && left.revision === right.revision
      && left.spriteUrl === right.spriteUrl
      && left.sallyUrl === right.sallyUrl
      && left.doneUrl === right.doneUrl
      && left.overlayTopmost === right.overlayTopmost
      && left.overlayAlwaysShow === right.overlayAlwaysShow
    )

    const INITIAL_HOST_STATE = {
      mode: 'idle',
      seq: 0,
      waiting: 0,
      waitingSeq: 0,
      celebrateSeq: 0,
      running: 0,
      revision: 1,
      spriteUrl: DEFAULT_SPRITE_URL,
      sallyUrl: null,
      doneUrl: null,
      overlayTopmost: true,
      overlayAlwaysShow: false,
    }

    const resolveService = (ctx, name) => {
      if (ctx === undefined || ctx === null) return undefined
      try {
        if (ctx[name] !== undefined && ctx[name] !== null) return ctx[name]
      } catch (error) {
        // getter may throw; fall through to ctx.get
      }
      if (typeof ctx.get === 'function') {
        try {
          return ctx.get(name)
        } catch (error) {
          return undefined
        }
      }
      return undefined
    }

    return {
      inject: ['slots', 'locale', 'timer'],

      apply(ctx) {
        if (ctx === undefined || ctx === null) {
          console.error('[duo-pet] plugin context is unavailable; the pet cannot mount')
          return
        }

        const slots = resolveService(ctx, 'slots')
        if (slots === undefined || slots === null || typeof slots.inject !== 'function') {
          console.error('[duo-pet] slots service is unavailable; the pet cannot mount')
          return
        }

        const locale = resolveService(ctx, 'locale')
        if (locale !== undefined && locale !== null && typeof locale.register === 'function') {
          try {
            ctx.effect(() => locale.register(NS, 'zh', zhDict))
            ctx.effect(() => locale.register(NS, 'en', enDict))
          } catch (error) {
            console.error('[duo-pet] locale registration failed:', error)
          }
        } else {
          console.error('[duo-pet] locale service is unavailable; using bundled dictionaries')
        }

        const translate = (key) => {
          if (locale !== undefined && locale !== null && typeof locale.bind === 'function') {
            try {
              const value = locale.bind(NS)(key)
              if (typeof value === 'string' && value !== key) return value
            } catch (error) {
              // fall through to the bundled dictionaries
            }
          }
          let chinese = false
          try {
            const active = locale !== undefined && locale !== null && typeof locale.getLocale === 'function'
              ? locale.getLocale().active
              : (typeof navigator === 'undefined' ? 'en' : navigator.language)
            chinese = String(active).toLowerCase().startsWith('zh')
          } catch (error) {
            chinese = false
          }
          const dict = chinese ? zhDict : enDict
          if (typeof dict[key] === 'string') return dict[key]
          if (typeof enDict[key] === 'string') return enDict[key]
          return key
        }

        // 计时器统一走 ctx.timeout / ctx.interval（返回 disposer）；缺失时用全局兜底。
        const setTimer = (callback, ms) => {
          if (typeof ctx.timeout === 'function') return ctx.timeout(callback, ms)
          if (typeof setTimeout !== 'function') return () => {}
          const id = setTimeout(callback, ms)
          return () => clearTimeout(id)
        }
        const startInterval = (callback, ms) => {
          if (typeof ctx.interval === 'function') return ctx.interval(callback, ms)
          if (typeof setInterval !== 'function') return () => {}
          const id = setInterval(callback, ms)
          return () => clearInterval(id)
        }
        const cancelTimer = (disposer) => {
          if (typeof disposer !== 'function') return
          try {
            disposer()
          } catch (error) {
            // timer already fired / disposed
          }
        }

        function DuoPet() {
          const [host, setHost] = React.useState(INITIAL_HOST_STATE)
          const [spriteState, setSpriteState] = React.useState('loading')
          const [playback, setPlayback] = React.useState({ action: 'idle', run: 0 })
          const [frame, setFrame] = React.useState(0)
          const [position, setPosition] = React.useState(() => readStoredPosition() || defaultPosition())
          const [dragging, setDragging] = React.useState(false)
          const [bubble, setBubble] = React.useState(null)
          const [menu, setMenu] = React.useState(null)
          const [petClosed, setPetClosed] = React.useState(false)
          const [subOpen, setSubOpen] = React.useState(false)

          const playbackRef = React.useRef('idle')
          const waitingRef = React.useRef(0)
          const lastWaitingSeqRef = React.useRef(null)
          const lastCelebrateSeqRef = React.useRef(null)
          const bubbleKindRef = React.useRef(null)
          const bubbleTimerRef = React.useRef(null)
          const bubbleEndTimerRef = React.useRef(null)
          const sallySinceRef = React.useRef(0)
          const dragRef = React.useRef(null)
          const sallyAudioRef = React.useRef(null)
          const doneAudioRef = React.useRef(null)
          const pendingSoundRef = React.useRef(null)
          const lastReportedVisibleRef = React.useRef(null)
          const spriteImageRef = React.useRef(null)
          const hitCanvasRef = React.useRef(null)
          const cellBoxRef = React.useRef(null)
          const rootRef = React.useRef(null)

          // ---------- 气泡 ----------
          const clearBubbleTimers = () => {
            if (bubbleTimerRef.current !== null) {
              cancelTimer(bubbleTimerRef.current)
              bubbleTimerRef.current = null
            }
            if (bubbleEndTimerRef.current !== null) {
              cancelTimer(bubbleEndTimerRef.current)
              bubbleEndTimerRef.current = null
            }
          }

          const hideBubble = (kind) => {
            if (typeof kind === 'string' && bubbleKindRef.current !== kind) return
            clearBubbleTimers()
            bubbleKindRef.current = null
            setBubble(null)
          }

          const showBubble = (key, kind, ms) => {
            clearBubbleTimers()
            bubbleKindRef.current = kind
            setBubble(key)
            if (typeof ms === 'number' && ms > 0) {
              bubbleTimerRef.current = setTimer(() => {
                bubbleTimerRef.current = null
                hideBubble(kind)
              }, ms)
            }
          }

          // 授权气泡：至少 4.5s，最长 8s；waiting > 0 期间保持，结束后 1.2s 消失。
          // `waitingNow` 取触发时 Host 快照里的 waiting；waitingRef 只由下方
          // host.waiting 的 effect 维护，避免轮询提前改掉 ref 导致漏掉「>0 → 0」的收尾。
          const showSallyBubble = (waitingNow) => {
            sallySinceRef.current = Date.now()
            showBubble('bubble.sally', 'sally', SALLY_BUBBLE_MAX_MS)
            if (waitingNow <= 0) {
              bubbleEndTimerRef.current = setTimer(() => {
                bubbleEndTimerRef.current = null
                hideBubble('sally')
              }, SALLY_BUBBLE_MIN_MS)
            }
          }

          const showDoneBubble = () => {
            showBubble('bubble.done', 'done', DONE_BUBBLE_MS)
          }

          // ---------- 动作播放 ----------
          const startPlayback = (action) => {
            playbackRef.current = action
            setPlayback((current) => ({ action, run: current.run + 1 }))
          }

          // ---------- 声音 ----------
          // 页面不可见（窗口被最小化/切走）时不播：此时由桌面悬浮层发声，避免两个声音叠在一起（重音）。
          const pageHidden = () => {
            try {
              return typeof document !== 'undefined' && document !== null && document.visibilityState === 'hidden'
            } catch (error) {
              return false
            }
          }

          const playSound = (kind) => {
            if (pageHidden()) return true
            const audio = kind === 'sally' ? sallyAudioRef.current : doneAudioRef.current
            if (audio === null || audio === undefined) return false
            const other = kind === 'sally' ? doneAudioRef.current : sallyAudioRef.current
            if (other !== null && other !== undefined && other !== audio) {
              try {
                other.pause()
                other.currentTime = 0
              } catch (error) {
                // some browsers reject currentTime writes before metadata loads
              }
            }
            try {
              audio.currentTime = 0
              const playing = audio.play()
              if (playing !== undefined && playing !== null && typeof playing.then === 'function') {
                playing.then(
                  () => {
                    if (pendingSoundRef.current === kind) pendingSoundRef.current = null
                  },
                  () => {
                    pendingSoundRef.current = kind
                  },
                )
              }
              return true
            } catch (error) {
              pendingSoundRef.current = kind
              return false
            }
          }

          // done.mp3 缺失时回退到浏览器 TTS（SPEC §5.3）。全部 try/catch。
          const speakDone = () => {
            try {
              if (typeof window === 'undefined' || window === null) return false
              const synth = window.speechSynthesis
              const Utterance = window.SpeechSynthesisUtterance
              if (synth === undefined || synth === null) return false
              if (typeof Utterance !== 'function' || typeof synth.speak !== 'function') return false
              const utterance = new Utterance('任务完成了')
              utterance.lang = 'zh-CN'
              utterance.pitch = 1.5
              utterance.rate = 1.05
              try {
                synth.cancel()
              } catch (error) {
                // cancel is best effort
              }
              synth.speak(utterance)
              return true
            } catch (error) {
              return false
            }
          }

          // ---------- Host 触发 ----------
          const triggerWaiting = (next) => {
            showSallyBubble(next.waiting)
            playSound('sally')
            // done 优先级最高：正在播 done 时不打断（SPEC §5.2 / §5.5）。
            if (playbackRef.current !== 'done') startPlayback('snuggle')
          }

          const triggerCelebrate = () => {
            showDoneBubble()
            startPlayback('done') // done > 等待/点击 snuggle > 自动循环
            if (doneAudioRef.current !== null && doneAudioRef.current !== undefined) {
              playSound('done')
            } else {
              speakDone()
            }
          }

          const handleHostState = (next) => {
            const previousWaitingSeq = lastWaitingSeqRef.current
            const previousCelebrateSeq = lastCelebrateSeqRef.current
            // 首次拿到 Host 状态：只记基线，不为历史事件补播（SPEC §5.6）。
            if (previousWaitingSeq === null || previousCelebrateSeq === null) {
              lastWaitingSeqRef.current = next.waitingSeq
              lastCelebrateSeqRef.current = next.celebrateSeq
              return
            }
            // Host 重启导致 seq 回退时重新对齐基线，避免把旧事件当新事件补播。
            if (next.waitingSeq < previousWaitingSeq) {
              lastWaitingSeqRef.current = next.waitingSeq
            } else if (next.waitingSeq > previousWaitingSeq) {
              lastWaitingSeqRef.current = next.waitingSeq
              triggerWaiting(next)
            }
            if (next.celebrateSeq < previousCelebrateSeq) {
              lastCelebrateSeqRef.current = next.celebrateSeq
            } else if (next.celebrateSeq > previousCelebrateSeq) {
              lastCelebrateSeqRef.current = next.celebrateSeq
              triggerCelebrate()
            }
          }

          const activate = () => {
            // 点击（非拖动）：解锁音频（补播被拦截的声音）并立刻贴贴一次（done 播放中不覆盖）。
            const pending = pendingSoundRef.current
            if (pending !== null) {
              pendingSoundRef.current = null
              playSound(pending)
            }
            if (playbackRef.current !== 'done') startPlayback('snuggle')
          }

          // ---------- 右键菜单（页内桌宠）：最小化 DSH / 动作 / 置顶 / 总是显示 / 关闭桌宠 ----------
          const postJson = (url, body) => {
            if (typeof fetch !== 'function') return
            try {
              const request = fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body === undefined ? {} : body),
                keepalive: true,
                cache: 'no-store',
              })
              if (request !== undefined && request !== null && typeof request.then === 'function') {
                request.then(() => {}, () => {})
              }
            } catch (error) {
              // best effort
            }
          }

          const openMenu = (event) => {
            if (typeof event.preventDefault === 'function') event.preventDefault()
            const element = event.currentTarget
            const rect = element !== null && element !== undefined && typeof element.getBoundingClientRect === 'function'
              ? element.getBoundingClientRect()
              : { left: 0, top: 0 }
            setMenu({
              x: Math.round(event.clientX - rect.left),
              y: Math.round(event.clientY - rect.top),
            })
          }

          const runMenuAction = (action) => {
            setMenu(null)
            if (action === 'minimize') {
              postJson(MINIMIZE_URL, {})
              return
            }
            if (action === 'topmost') {
              postJson(OVERLAY_OPTION_URL, { topmost: host.overlayTopmost !== true })
              return
            }
            if (action === 'alwaysShow') {
              postJson(OVERLAY_OPTION_URL, { alwaysShow: host.overlayAlwaysShow !== true })
              return
            }
            if (action === 'closePet') {
              setPetClosed(true)
              return
            }
            if (action === 'celebrate') {
              triggerCelebrate()
              return
            }
            if (action === 'snuggle') {
              if (playbackRef.current !== 'done') startPlayback('snuggle')
              return
            }
            startPlayback('idle')
          }

          // 菜单打开时：点别处 / Esc 关闭。
          React.useEffect(() => {
            if (menu === null) return undefined
            const close = () => setMenu(null)
            const onEscape = (event) => {
              if (event.key === 'Escape') close()
            }
            window.addEventListener('pointerdown', close)
            window.addEventListener('keydown', onEscape, true)
            return () => {
              window.removeEventListener('pointerdown', close)
              window.removeEventListener('keydown', onEscape, true)
            }
          }, [menu])

          // ---------- 挂载：首次提示气泡 ----------
          React.useEffect(() => {
            showBubble('bubble.hint', 'hint', HINT_BUBBLE_MS)
            return () => {
              clearBubbleTimers()
            }
          }, [])

          // ---------- 精灵图预加载：失败时自动重试 3 次（换 cache-bust 参数），仍失败才 emoji 兜底 ----------
          React.useEffect(() => {
            let alive = true
            let timer = null
            let attempt = 0
            let image = null
            const load = () => {
              const url = withArtBust(host.spriteUrl)
              if (url === null || typeof Image === 'undefined') {
                setSpriteState('error')
                return
              }
              setSpriteState('loading')
              image = new Image()
              image.onload = () => {
                spriteImageRef.current = image
                if (alive) setSpriteState('ready')
              }
              image.onerror = () => {
                if (!alive) return
                if (attempt < 3) {
                  attempt += 1
                  timer = setTimer(load, 600)
                  return
                }
                setSpriteState('error')
              }
              // 重试时附加 r=<n>，避免浏览器复用上一次失败的缓存条目。
              image.src = url + '&r=' + attempt
            }
            load()
            return () => {
              alive = false
              cancelTimer(timer)
              timer = null
              if (image !== null) {
                image.onload = null
                image.onerror = null
              }
            }
          }, [host.spriteUrl])

          // ---------- 500ms 轮询 Host state（失败容错，保留上一份状态） ----------
          // 同时把「页面当前是否可见」上报给 Host（5s 一次 + visibilitychange 立即上报），
          // 桌面悬浮层据此决定自己要不要出声，避免「页面隐藏 + 悬浮层也隐藏」时谁都不响。
          React.useEffect(() => {
            if (typeof fetch !== 'function') {
              return undefined
            }
            const send = () => {
              let visible = true
              try {
                visible = document.visibilityState !== 'hidden'
              } catch (error) {
                visible = true
              }
              if (lastReportedVisibleRef.current === visible) return
              lastReportedVisibleRef.current = visible
              try {
                const request = fetch(VISIBILITY_URL, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ visible }),
                  keepalive: true,
                  cache: 'no-store',
                })
                if (request !== undefined && request !== null && typeof request.then === 'function') {
                  request.then(() => {}, () => {})
                }
              } catch (error) {
                // reporting is best effort
              }
            }
            send()
            const listener = () => send()
            window.addEventListener('visibilitychange', listener)
            window.addEventListener('focus', listener)
            window.addEventListener('blur', listener)
            const stopVisibility = startInterval(send, 5000)
            return () => {
              window.removeEventListener('visibilitychange', listener)
              window.removeEventListener('focus', listener)
              window.removeEventListener('blur', listener)
              cancelTimer(stopVisibility)
            }
          }, [])

          React.useEffect(() => {
            let alive = true
            const sync = () => {
              if (typeof fetch !== 'function') return
              let request
              try {
                request = fetch(STATE_URL, { cache: 'no-store' })
              } catch (error) {
                return
              }
              if (request === undefined || request === null || typeof request.then !== 'function') return
              request
                .then((response) => (response !== null && response !== undefined && response.ok ? response.json() : null))
                .then((value) => {
                  if (!alive || value === null || typeof value !== 'object') return
                  const next = normalizeHostState(value)
                  setHost((previous) => (hostStateEquals(previous, next) ? previous : next))
                  handleHostState(next)
                })
                .catch(() => {
                  // transient request failure; keep the previous state and the animation
                })
            }
            sync()
            const stop = startInterval(sync, POLL_MS)
            return () => {
              alive = false
              cancelTimer(stop)
            }
          }, [])

          // ---------- 逐帧播放 ----------
          React.useEffect(() => {
            const action = playback.action
            const animation = ANIMATIONS[action] || ANIMATIONS.idle
            const looping = action === 'idle'
            let disposed = false
            let timer = null
            const step = (index) => {
              if (disposed) return
              setFrame(index)
              const delay = animation.frames[index]
              timer = setTimer(() => {
                if (disposed) return
                // 动作已被新的触发替换时，旧计时器即使抢在 effect cleanup 之前触发也自行退出。
                if (playbackRef.current !== action) return
                const following = index + 1
                if (following < animation.frames.length) {
                  step(following)
                } else if (looping) {
                  step(0)
                } else {
                  startPlayback('idle') // snuggle / done 播完回正常 5s 循环
                }
              }, typeof delay === 'number' ? delay : 100)
            }
            step(0)
            return () => {
              disposed = true
              cancelTimer(timer)
              timer = null
            }
          }, [playback])

          // ---------- 自动 5s 循环：idle 2.0s 后自动 snuggle（两人贴贴 + 爱心） ----------
          React.useEffect(() => {
            if (playback.action !== 'idle') return undefined
            let disposed = false
            const timer = setTimer(() => {
              if (disposed) return
              if (playbackRef.current === 'idle') startPlayback('snuggle')
            }, IDLE_PLAY_MS)
            return () => {
              disposed = true
              cancelTimer(timer)
            }
          }, [playback])

          // ---------- 授权气泡随 waiting 收尾 ----------
          React.useEffect(() => {
            const current = host.waiting
            const previous = waitingRef.current
            waitingRef.current = current
            if (bubbleKindRef.current !== 'sally') return
            if (current > 0) {
              if (bubbleEndTimerRef.current !== null) {
                cancelTimer(bubbleEndTimerRef.current)
                bubbleEndTimerRef.current = null
              }
              return
            }
            if (previous > 0) {
              const elapsed = Date.now() - sallySinceRef.current
              const delay = Math.max(SALLY_END_HOLD_MS, SALLY_BUBBLE_MIN_MS - elapsed)
              if (bubbleEndTimerRef.current !== null) cancelTimer(bubbleEndTimerRef.current)
              bubbleEndTimerRef.current = setTimer(() => {
                bubbleEndTimerRef.current = null
                hideBubble('sally')
              }, delay)
            }
          }, [host.waiting])

          // ---------- 窗口 resize：clamp 回可视区 ----------
          React.useEffect(() => {
            if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
            const onResize = () => {
              setPosition((current) => {
                const next = clampPosition(current.left, current.top)
                if (next.left === current.left && next.top === current.top) return current
                return next
              })
            }
            window.addEventListener('resize', onResize)
            return () => window.removeEventListener('resize', onResize)
          }, [])

          // ---------- 音频解锁：首个用户手势后补播被拦截的声音 ----------
          React.useEffect(() => {
            if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
            const onGesture = () => {
              const pending = pendingSoundRef.current
              if (pending !== null) {
                pendingSoundRef.current = null
                playSound(pending)
              }
            }
            window.addEventListener('pointerdown', onGesture, true)
            window.addEventListener('keydown', onGesture, true)
            return () => {
              window.removeEventListener('pointerdown', onGesture, true)
              window.removeEventListener('keydown', onGesture, true)
              try {
                if (window.speechSynthesis !== undefined && window.speechSynthesis !== null) {
                  window.speechSynthesis.cancel()
                }
              } catch (error) {
                // speechSynthesis may be unavailable
              }
            }
          }, [])

          // ---------- 拖拽 ----------
          // 只有按在「角色可见像素」上才响应拖动/点击；周围的透明留白不劫持鼠标。
          const rootRect = () => {
            const element = rootRef.current
            if (element === null || element === undefined || typeof element.getBoundingClientRect !== 'function') {
              return { left: position.left, top: position.top, width: W, height: H }
            }
            return element.getBoundingClientRect()
          }

          const spriteHit = (event) => {
            const image = spriteImageRef.current
            if (image === null || image === undefined) return true
            try {
              const rect = rootRect()
              if (rect.width <= 0 || rect.height <= 0) return true
              const lx = ((event.clientX - rect.left) / rect.width) * CELL
              const ly = ((event.clientY - rect.top) / rect.height) * CELL_H
              if (lx < 0 || ly < 0 || lx >= CELL || ly >= CELL_H) return false
              const pos = frameFor(playback.action, frame)
              let canvas = hitCanvasRef.current
              if (canvas === null || canvas === undefined) {
                canvas = document.createElement('canvas')
                canvas.width = CELL
                canvas.height = CELL_H
                hitCanvasRef.current = canvas
              }
              const context = canvas.getContext('2d')
              if (context === null || context === undefined) return true
              context.clearRect(0, 0, CELL, CELL_H)
              context.drawImage(image, pos.col * CELL, pos.row * CELL_H, CELL, CELL_H, 0, 0, CELL, CELL_H)
              const alpha = context.getImageData(Math.floor(lx), Math.floor(ly), 1, 1).data[3]
              return alpha > 16
            } catch (error) {
              // 读不到像素时退回「整块可拖」，不影响可用性。
              return true
            }
          }

          // 当前帧 cell 的 alpha 包围盒（页面显示像素），按 cell 缓存；用于把交互区框在人物实际大小上。
          const computeCellBox = (row, col) => {
            const image = spriteImageRef.current
            if (image === null || image === undefined) return null
            let cache = cellBoxRef.current
            if (cache === null || cache === undefined) {
              cache = new Map()
              cellBoxRef.current = cache
            }
            const key = row + ':' + col
            if (cache.has(key)) return cache.get(key)
            try {
              let canvas = hitCanvasRef.current
              if (canvas === null || canvas === undefined) {
                canvas = document.createElement('canvas')
                canvas.width = CELL
                canvas.height = CELL_H
                hitCanvasRef.current = canvas
              }
              const context = canvas.getContext('2d')
              if (context === null || context === undefined) return null
              context.clearRect(0, 0, CELL, CELL_H)
              context.drawImage(image, col * CELL, row * CELL_H, CELL, CELL_H, 0, 0, CELL, CELL_H)
              const data = context.getImageData(0, 0, CELL, CELL_H).data
              let minX = CELL
              let minY = CELL_H
              let maxX = -1
              let maxY = -1
              for (let y = 0; y < CELL_H; y += 1) {
                const rowOffset = y * CELL * 4
                for (let x = 0; x < CELL; x += 1) {
                  if (data[rowOffset + x * 4 + 3] > 16) {
                    if (x < minX) minX = x
                    if (x > maxX) maxX = x
                    if (y < minY) minY = y
                    if (y > maxY) maxY = y
                  }
                }
              }
              if (maxX < 0) return null
              const box = {
                left: Math.max(0, Math.floor(minX * SCALE) - 1),
                top: Math.max(0, Math.floor(minY * SCALE) - 1),
                width: Math.ceil((maxX - minX + 1) * SCALE) + 2,
                height: Math.ceil((maxY - minY + 1) * SCALE) + 2,
              }
              cache.set(key, box)
              return box
            } catch (error) {
              return null
            }
          }

          const onPointerDown = (event) => {
            if (typeof event.button === 'number' && event.button !== 0) return
            if (!spriteHit(event)) return
            const element = event.currentTarget
            if (element !== null && element !== undefined && typeof element.setPointerCapture === 'function') {
              try {
                element.setPointerCapture(event.pointerId)
              } catch (error) {
                // pointer capture is optional
              }
            }
            const rect = rootRect()
            dragRef.current = {
              pointerId: event.pointerId,
              startX: event.clientX,
              startY: event.clientY,
              originLeft: rect.left,
              originTop: rect.top,
              moved: false,
              last: null,
            }
          }

          const onPointerMove = (event) => {
            const drag = dragRef.current
            if (drag === null) return
            const dx = event.clientX - drag.startX
            const dy = event.clientY - drag.startY
            if (!drag.moved) {
              if (Math.abs(dx) <= DRAG_THRESHOLD && Math.abs(dy) <= DRAG_THRESHOLD) return
              drag.moved = true
              setDragging(true)
              if (bubbleKindRef.current !== 'sally' && bubbleKindRef.current !== 'done') {
                showBubble('bubble.dragging', 'dragging', 0)
              }
            }
            const next = clampPosition(drag.originLeft + dx, drag.originTop + dy)
            drag.last = next
            setPosition(next)
          }

          const finishPointer = (event, allowClick) => {
            const drag = dragRef.current
            if (drag === null) return
            dragRef.current = null
            const element = event.currentTarget
            if (element !== null && element !== undefined && typeof element.releasePointerCapture === 'function') {
              try {
                element.releasePointerCapture(drag.pointerId)
              } catch (error) {
                // pointer capture is optional
              }
            }
            if (!drag.moved) {
              if (allowClick) activate()
              return
            }
            setDragging(false)
            if (drag.last !== null) saveStoredPosition(drag.last)
            if (bubbleKindRef.current === 'dragging') hideBubble('dragging')
          }

          const onPointerUp = (event) => {
            finishPointer(event, true)
          }

          const onPointerCancel = (event) => {
            finishPointer(event, false)
          }

          const onKeyDown = (event) => {
            const key = event.key
            if (key !== 'Enter' && key !== ' ' && key !== 'Spacebar') return
            event.preventDefault()
            activate()
          }

          // ---------- 渲染 ----------
          const frameInfo = frameFor(playback.action, frame)
          const spriteStyle = {
            width: W,
            height: H,
            backgroundImage: `url("${withArtBust(host.spriteUrl)}")`,
            backgroundSize: `${SPRITE_WIDTH}px ${SPRITE_HEIGHT}px`,
            backgroundPosition: `${-(frameInfo.col * W)}px ${-(frameInfo.row * H)}px`,
          }
          const rootStyle = {
            position: 'fixed',
            left: position.left,
            top: position.top,
            width: W,
            height: H,
            zIndex: 1000,
            pointerEvents: 'auto',
            userSelect: 'none',
            WebkitUserSelect: 'none',
            touchAction: 'none',
            cursor: dragging ? 'grabbing' : 'grab',
          }

          const bubbleText = typeof bubble === 'string' ? translate(bubble) : null
          const children = [h('style', { key: 'style' }, CSS)]

          if (spriteState === 'error' || host.spriteUrl === null) {
            children.push(h('div', {
              key: 'fallback',
              className: 'duopet-fallback',
              'aria-hidden': true,
            }, '🧡💙'))
          } else {
            children.push(h('div', {
              key: 'sprite',
              className: 'duopet-sprite',
              style: spriteStyle,
              'aria-hidden': true,
            }))
          }

          if (bubbleText !== null) {
            children.push(h('div', {
              key: 'bubble',
              className: 'duopet-bubble',
              role: 'status',
              'aria-live': 'polite',
            }, bubbleText))
          }

          if (menu !== null) {
            children.push(h('div', {
              key: 'menu',
              className: 'duopet-menu',
              role: 'menu',
              style: { left: menu.x + 'px', top: menu.y + 'px' },
              // 菜单内的按下不要冒泡到根部（否则会开始拖动）。
              onPointerDown: (event) => {
                if (typeof event.stopPropagation === 'function') event.stopPropagation()
              },
              onPointerLeave: () => {
                setSubOpen(false)
              },
            }, [
              h('button', {
                key: 'minimize',
                type: 'button',
                role: 'menuitem',
                className: 'duopet-menu-item',
                onClick: () => runMenuAction('minimize'),
              }, translate('menu.minimizeDsh')),
              h('button', {
                key: 'action',
                type: 'button',
                role: 'menuitem',
                className: 'duopet-menu-item duopet-menu-parent',
                onPointerEnter: () => {
                  setSubOpen(true)
                },
                onClick: () => {
                  setSubOpen((current) => !current)
                },
              }, [translate('menu.action'), h('span', { key: 'arrow', className: 'duopet-menu-arrow' }, '▸')]),
              subOpen ? h('div', {
                key: 'submenu',
                className: 'duopet-submenu',
                role: 'menu',
              }, [
                h('button', {
                  key: 'snuggle',
                  type: 'button',
                  role: 'menuitem',
                  className: 'duopet-menu-item',
                  onClick: () => runMenuAction('snuggle'),
                }, translate('menu.snuggle')),
                h('button', {
                  key: 'celebrate',
                  type: 'button',
                  role: 'menuitem',
                  className: 'duopet-menu-item',
                  onClick: () => runMenuAction('celebrate'),
                }, translate('menu.celebrate')),
                h('button', {
                  key: 'idle',
                  type: 'button',
                  role: 'menuitem',
                  className: 'duopet-menu-item',
                  onClick: () => runMenuAction('idle'),
                }, translate('menu.idle')),
              ]) : null,
              h('div', { key: 'sep1', className: 'duopet-menu-sep' }),
              h('button', {
                key: 'topmost',
                type: 'button',
                role: 'menuitem',
                className: 'duopet-menu-item',
                onClick: () => runMenuAction('topmost'),
              }, host.overlayTopmost === true ? translate('menu.untopmost') : translate('menu.topmost')),
              h('button', {
                key: 'alwaysShow',
                type: 'button',
                role: 'menuitem',
                className: 'duopet-menu-item',
                onClick: () => runMenuAction('alwaysShow'),
              }, host.overlayAlwaysShow === true ? translate('menu.cancelAlwaysShow') : translate('menu.alwaysShow')),
              h('div', { key: 'sep2', className: 'duopet-menu-sep' }),
              h('button', {
                key: 'closePet',
                type: 'button',
                role: 'menuitem',
                className: 'duopet-menu-item',
                onClick: () => runMenuAction('closePet'),
              }, translate('menu.closePet')),
            ]))
          }

          // 交互区：**按当前帧**两个小人的实际包围盒（每次换帧重算，缓存到 cell），
          // 不再是所有帧的并集（并集会比 idle 时的人物高出很多）；气泡显示时并入气泡框。
          const currentPos = frameFor(playback.action, frame)
          const frameBox = computeCellBox(currentPos.row, currentPos.col)
          const baseBox = frameBox !== null
            ? frameBox
            : { left: PET_BOX.left, top: PET_BOX.top, width: PET_BOX.width, height: PET_BOX.height }
          const hitBox = {
            left: baseBox.left,
            top: baseBox.top,
            right: baseBox.left + baseBox.width,
            bottom: baseBox.top + baseBox.height,
          }
          if (bubbleText !== null) {
            // 气泡框（left≈20、宽≤180、在头顶上方），显示时并入命中区。
            hitBox.left = Math.min(hitBox.left, 20)
            hitBox.top = Math.min(hitBox.top, 40)
            hitBox.right = Math.max(hitBox.right, 200)
            hitBox.bottom = Math.max(hitBox.bottom, 100)
          }
          children.push(h('div', {
            key: 'hit',
            className: 'duopet-hit',
            'aria-hidden': true,
            style: {
              left: hitBox.left + 'px',
              top: hitBox.top + 'px',
              width: (hitBox.right - hitBox.left) + 'px',
              height: (hitBox.bottom - hitBox.top) + 'px',
            },
            onPointerDown,
            onPointerMove,
            onPointerUp,
            onPointerCancel,
            onContextMenu: openMenu,
          }))

          if (host.sallyUrl !== null) {
            children.push(h('audio', {
              key: 'sally',
              // av=2：授权人声换过一版，用 query 破坏浏览器对旧 mp3 的缓存。
              src: host.sallyUrl + (host.sallyUrl.indexOf('?') === -1 ? '?av=2' : '&av=2'),
              preload: 'auto',
              'aria-hidden': true,
              style: { display: 'none' },
              ref: (element) => {
                sallyAudioRef.current = element
              },
            }))
          }
          if (host.doneUrl !== null) {
            children.push(h('audio', {
              key: 'done',
              // dv=2：完成音也换成了用户提供的人声，破浏览器缓存。
              src: host.doneUrl + (host.doneUrl.indexOf('?') === -1 ? '?dv=2' : '&dv=2'),
              preload: 'auto',
              'aria-hidden': true,
              style: { display: 'none' },
              ref: (element) => {
                doneAudioRef.current = element
              },
            }))
          }

          // 「关闭桌宠」：本次页面会话内隐藏桌宠（刷新页面恢复）。
          if (petClosed) return null

          return h('div', {
            className: 'duopet-root',
            role: 'button',
            tabIndex: 0,
            'aria-label': translate('meta.title'),
            title: translate('meta.title'),
            onKeyDown,
            ref: (element) => {
              rootRef.current = element
            },
            style: rootStyle,
          }, children)
        }

        slots.inject('shell.overlay', () => slots.register({
          name: 'shell.overlay',
          id: 'duo-pet',
          order: 120,
          label: () => translate('meta.title'),
        }, DuoPet))
      },

      _internals: { ANIMATIONS, frameFor, durationsOf },
    }
  },
})
