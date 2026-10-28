# Claude × DeepSeek 桌宠（DSH Web 插件）

为 [DeepSeek Harness](https://github.com/deepseek-ai) 的 Web 界面做的双人桌宠插件：左边 **Claude**（橘发少女）、右边 **DeepSeek**（蓝发女仆），**每 5 秒两人贴贴 3 秒、中间冒爱心**；需要你授权/选择或任务完成时 Claude 头顶气泡「你盐津虾嘛」。DSH 主窗口最小化时还有**桌面悬浮桌宠**。

![贴贴预览](docs/preview-snuggle.png)

## 功能

| 场景 | 表现 |
|---|---|
| 自动循环 | `idle` 2.0s → `snuggle` 3.0s → `idle`，即每 5 秒两人贴贴 3 秒（3 颗爱心上浮） |
| 需要授权 / 选择 | 气泡「盐津虾嘛」+ 播放 `assets/sally.mp3`（授权人声），立即贴贴一次；等待期间气泡保持 |
| 任务完成 | 气泡「任务完成了」+ 播放 `assets/done.mp3` + `done` 小跳动画（缺失时回退浏览器 TTS） |
| 点击 | 解锁音频并贴贴一次 |
| 拖动 | 只有按在**人物可见像素**上才能拖；位置记忆（`localStorage`），窗口 resize 自动 clamp 回可视区 |
| 右键 | **页内与桌面菜单一致**：最小化 DSH（页内）/ 打开 DSH（桌面）/ 动作 ▸ 贴贴·庆祝·待机 / 置顶（取消置顶）/ 总是显示（取消总是显示）/ 关闭桌宠 |
| 桌面悬浮层 | DSH 页面可见时**自动隐藏**（页内只看得到一个桌宠）；最小化/切走时在桌面右下角显示透明置顶桌宠；窗口和命中区都**紧贴当前帧人物 bbox** |
| 最小化 DSH | 页内右键「最小化 DSH」→ Host spawn `window-probe.ps1 -Action minimize` 最小化主窗口 |

- 交互区域 = **当前动画帧人物的实际包围盒**（有气泡时并入气泡），透明留白不拦截鼠标。
- **只显示一个桌宠**：页内可见时桌面悬浮层自动隐藏；页面隐藏（最小化/切走）时才显示桌面桌宠。
- 页内与桌面悬浮层不会重复出声（页面可见性协调，`/duo-pet/page-visibility`）。
- 页内菜单的「置顶 / 总是显示」与桌面菜单状态**双向同步**（`/duo-pet/overlay-option`）。
- 支持中英文本地化（`locale/zh.json`、`locale/en.json`）。

## 安装

本插件是 DSH 的 **profile bundle**（Host 半 + Client 半），不是独立网页/应用。

```bash
# 1. 把本仓库放到任意目录，例如 D:\plugging\duo-pet
# 2. 在 DSH 里安装（用插件管理器安装本地路径的 bundle）
```

通过 DSH 的插件管理器 `install_bundle` 指向本目录即可（或把 `dsh.bundle` 清单用 `plugin_manager` 安装）。安装后插件会：

- 在 `shell.overlay` 槽位渲染桌宠（Host 路由 `/duo-pet/state`、`/duo-pet/spritesheet.png`、`/duo-pet/sally.mp3`、`/duo-pet/done.mp3`、`/duo-pet/page-visibility`）
- 在 Windows 上自动 spawn `desktop/pet-overlay.ps1`（透明置顶悬浮窗，依赖 PowerShell + WPF）

设置环境变量 `DSH_DUO_PET_DESKTOP_DISABLE=1` 可只保留页内桌宠、不启动桌面悬浮层。

## 素材契约（可替换成你自己的角色）

- `assets/spritesheet.png`：5280×2400 RGBA，**12 列 × 5 行**，单元格 **440×480**
  - row 0：`idle` 8 帧 × 250 ms
  - row 1-3：`snuggle` 36 帧 × 83 ms（第 i 帧 → `row = 1 + floor(i/12)`、`col = i % 12`）
  - row 4：`done` 12 帧 × 100 ms
  - 未使用的格子（row0 col8-11）保持全透明；相邻帧不同
- 页面显示比例 0.65 → 286×312 px
- `assets/sally.mp3` / `assets/done.mp3`：任意提示音（授权音 / 完成音）
- 详细契约见 [SPEC.md](SPEC.md)

## 目录结构

```
duo-pet/
├─ index.js              # Host 半：素材路由、状态机、桌面悬浮层 spawn
├─ client.js             # Client 半：shell.overlay 渲染、动画、气泡、右键菜单、命中区域
├─ cordis.patch.yml      # bundle patch（插入 duo-pet 一行）
├─ locale/               # 中英文案
├─ desktop/              # 桌面悬浮层（PowerShell/WPF，ASCII-only）
│  ├─ pet-overlay.ps1
│  ├─ window-probe.ps1
│  └─ messages.json
├─ assets/               # 精灵图 + 提示音
├─ docs/                 # 预览图
├─ tools/                # 美术生成脚本（可选，需要参考素材与 Pillow）
└─ SPEC.md               # 详细技术规格
```

## 技术要点

- Host：`webServer` exact 路由；监听 `agent/status`、`agent/error`、`approval/request`、`user-questions/request` + 500ms 轮询兜底；素材按 mtime/size 惰性加载并带内容戳（`&h=`）实现**热更新**。
- Client：`shell.overlay` 槽位；500ms 轮询状态；逐帧定时器；音频解锁与补播；精灵图加载失败自动重试 3 次后 emoji 兜底；页内/桌面悬浮层声音协调。
- 桌面悬浮层：WPF 透明置顶窗；`WM_NCHITTEST` 区域外返回 `HTTRANSPARENT`，窗口尺寸=当前帧人物 bbox（气泡出现时临时扩窗）；右键菜单；单实例互斥；Host 退出自动退出。

## 预览

| 嘴部 | 贴贴 |
|---|---|
| ![嘴部](docs/preview-mouth.png) | ![贴贴特写](docs/preview-snuggle-zoom.png) |

## License

代码：MIT（见 [LICENSE](LICENSE)）。
角色素材：来自作者参考的个人素材（fan art），仅限个人非商业使用，商业使用请先取得原角色权利方许可。
