# 第三方组件声明

本项目的代码以 MIT 授权（见根目录 `LICENSE`）。但有几部分不是我们的，列在这里。

---

## 1. dsh-pet —— 桌面宠物动画素材

- **项目**：<https://github.com/PC2005-cloud/dsh-pet>
- **作者**：PC2005-cloud
- **我们用到的部分**：`assets/third-party/webm/` 下的 .webm 动画文件（上游全部 106 个，约 52MB）

### 许可（分三块，不是同一份）

上游的许可不是一句话，按部分分：

| 部分 | 上游许可 | 商用 |
|---|---|---|
| 代码 | MIT | 可以 |
| **动画素材 / 提示词 / 源视频** | 允许开源使用 | **禁止商用** |
| **角色形象**（「大肥鱼」鲸鱼娘） | CC BY-NC-SA 4.0 | **不可以以任何形式商业化** |

上游原文（README「许可」节）：

> - 代码：MIT
> - 素材（动画/提示词/源视频）：允许开源使用，**禁止商用**
> - **形象授权**：CC BY-NC-SA 4.0（署名 · 非商业 · 相同方式共享），声明原文：
>   「大肥鱼是遵守 CC BY-NC-SA 4.0 协议的形象，不可以以任何形式商业化。」

**所以本项目也不能给你商用授权。** 我们只是使用者，没有权利替原作者放宽 ——
即使本项目的代码是 MIT，那 106 个动画和角色形象仍然只能用于非商业场景。
想商用，唯一干净的办法是把它们换成你自己生成的素材（见下）。

### 二创署名要求

上游对衍生作品有一条约定：基于 dsh-pet 的衍生 / 改版 / 换皮作品，
在 GitHub 仓库、产品官网等**公开渠道**上需要附上原作者地址：

> <https://github.com/PC2005-cloud/dsh-pet>

### 形象出处

宠物形象是社区二创的 DeepSeek「大肥鱼」（鲸鱼娘），**非 DeepSeek 官方形象**。
原型「溟月」出自 B 站 @上善无形，DeepSeek 版（女仆鲸鱼娘）设计出自 B 站 @ZipZipPipe。

### 我们只用了素材

项目的代码（`src/` 下的 app/client/host 结构）一行都没有抄 —— 本项目的引擎是独立实现的。

这些动画本身由 AI 视频生成工具（豆包）生成，dsh-pet 同时开源了生成配方（`prompts/`）
和从源视频到透明动画的完整管线（`scripts/`），并说明「换角色、换动作、换风格，全流程可复现」。

### 怎么换成自己的

照着 dsh-pet 的 `MAKE-YOUR-OWN-PET.md` 走一遍，产出的文件同名放进 `content/assets/`
就会自动覆盖这里的第三方素材（优先级见 `engine/paths.js` 的 `assetIndex()`）。
换成自己的素材之后，那些素材的许可由**你**定，上面这些限制与你无关。

许可全文另见 [`assets/third-party/LICENSE-dsh-pet.txt`](assets/third-party/LICENSE-dsh-pet.txt)。

---

## 2. Electron

**本项目不分发 Electron。** 运行引擎用的是 WorkBuddy 自带的那一份，
由 WorkBuddy 自己安装和升级；本仓库既不含二进制，也没有 `dependencies`，
`npm install` 不需要跑。

Electron 本身是 MIT 授权，本项目不修改它，也不打包它。

---

## 3. 宿主平台的 hook 事件规范

`host/hook-bridge.sh` 处理的事件名（SessionStart / PreToolUse / PostToolUse ……）
来自所运行 agent 的公开扩展机制。本项目的适配层只读写用户自己的配置文件
（`~/.workbuddy/settings.json` 的 `hooks` 键），不包含、不反编译宿主的任何代码。

如果你把本项目接到别的 agent 上，请自行确认该 agent 的用户协议是否允许第三方扩展。
