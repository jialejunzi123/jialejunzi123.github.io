# 日记同步管道（tools/）

把手机 App **侠客日记（SwashbucklerDiary）** 的 WebDAV（坚果云）备份，变成 https://jialejunzi.xyz/diary/ 上的日记页。

架构与数据契约以仓库根的 `diary-contract.md` 为准，尤其是「三·补三 · 发布架构」——**日记数据不进仓库**。

---

## 0. 整体架构（方案 B）

```
手机 App ──WebDAV 上传──▶ 坚果云 dav.jianguoyun.com
                              │
                              │ ① 每次构建时 PROPFIND + GET（Actions 内网侧，无 CORS 问题）
                              ▼
                     GitHub Actions (deploy.yml)
                       ├─ build : checkout → node 24 → node tools/build-site.mjs --webdav
                       │            → 生成 _site/（静态站文件 + diary/data 密文 + 加密图片）
                       │            → actions/upload-pages-artifact (path: _site)
                       └─ deploy: actions/deploy-pages → GitHub Pages → https://jialejunzi.xyz
```

关键点：

- **仓库里永远没有日记数据**。`diary/data`、`diary/media`、`_site` 都在 `.gitignore` 里，只在本地预览和构建产物（Pages artifact）中出现。
- 生产走**密码模式**：产物里只有 `diaries.enc.json` 和 `media/*.enc`，明文永不落盘、永不进 git。
- 浏览器**不能**直连坚果云（实测 `OPTIONS https://dav.jianguoyun.com/dav/` 返回 401 且没有 `Access-Control-Allow-Origin`），所以取数只能放在构建侧。

---

## 1. 文件清单

| 文件 | 作用 |
| --- | --- |
| `sync-diary.mjs` | 生成器：读 zip → 读 db3 → 按契约生成 `diary/data/diaries.json`（或密文）→ 落媒体到 `diary/media/` |
| `build-site.mjs` | 组装生产产物 `_site/`＝静态站文件 + 现生成的日记数据；**生产入口**，内部直接复用 `sync-diary.mjs` 的 `generateDiary()` |
| `verify-decrypt.mjs` | 独立解密校验（用 WebCrypto，故意不复用生成器的加密代码，等于顺带验证浏览器端能不能解开） |
| `check-plaintext-leak.mjs` | 明文泄漏守卫：用真实数据反查「将会被提交的文件」，专抓"把日记原文抄进文档/代码"（输出默认脱敏，见 §11.12） |
| `sync-diary.ps1` | Windows 一键：找最新 zip → 生成本地预览 → 数据泄漏自检 →（可选）起服务 / 只推代码 |
| `package.json` / `package-lock.json` | 零运行时依赖（只用 Node 内置模块），`package-lock.json` 只为让 CI 的 `npm ci` 能跑 |
| `config.json` | **本机私密**（已被 `tools/.gitignore` 忽略）：本机密码、本机坚果云目录。`config.example.json` 是模板 |
| `../.github/workflows/deploy.yml` | 两段式 build → deploy，不写仓库 |

依赖说明：zip 解压用 `node:zlib`（自己解析中央目录 + inflate），SQLite 用内置 `node:sqlite`，加解密用 `node:crypto`。**不需要 unzip / 7z / sqlite3 之类的系统命令**，Windows 本机和 ubuntu-latest 行为一致。

> Node 版本要求 **≥ 22.5**（`node:sqlite` 的 `DatabaseSync`），CI 用 24。

---

## 2. 本地怎么跑（预览）

```bash
# 本地预览：生成到 diary/data + diary/media（已 gitignore），不碰仓库其它地方
node tools/sync-diary.mjs --local

# 指定坚果云本机目录 / 指定 zip
node tools/sync-diary.mjs --local --dir "C:/Users/jiale/Nutstore/1/SwashbucklerDiary"
node tools/sync-diary.mjs --local --zip path/to/SwashbucklerDiaryBackup_20261030202537_v1.31.5.zip

# 生成后起服务看效果
python -m http.server 8080        # 然后访问 http://127.0.0.1:8080/diary/
```

Windows 一键（等价于上面，还带数据泄漏自检）：

```powershell
.\tools\sync-diary.ps1                 # 生成到 diary/data
.\tools\sync-diary.ps1 -Serve          # 生成后起本地服务并自动开浏览器
.\tools\sync-diary.ps1 -Build          # 改组装 _site/（等同于线上产物，自查用）
.\tools\sync-diary.ps1 -IncludePrivate # 连 Private 日记一起生成（只在本机看）
```

注册计划任务（开机跑一次 / 每 30 分钟跑一次，仅生成预览）：

```powershell
$ps1 = "F:\AI\Workspace\dsh\jialejunzi-site\tools\sync-diary.ps1"
schtasks /Create /TN "diary-sync-onstart" /SC ONSTART /RL LIMITED /F /TR "powershell -NoProfile -ExecutionPolicy Bypass -File `"$ps1`""
schtasks /Create /TN "diary-sync-30m"     /SC MINUTE /MO 30 /RL LIMITED /F /TR "powershell -NoProfile -ExecutionPolicy Bypass -File `"$ps1`""
# 查看 / 删除
schtasks /Query  /TN "diary-sync-30m" /V /FO LIST
schtasks /Delete /TN "diary-sync-30m" /F
```

> ⚠️ `diary/data`、`diary/media` 是**生成器独占**目录。你手工往里放的夹具文件会在下次生成时被覆盖/清理（密码模式还会删掉明文媒体）。

### 模式：明文 vs 密码

| | 触发条件 | 数据文件 | 媒体 |
| --- | --- | --- | --- |
| 明文模式 | 没有密码（或 `--plain`） | `diary/data/diaries.json` | `diary/media/<basename>` |
| **密码模式（线上用）** | 设了 `DIARY_PASSWORD` 或 `config.json` 的 `password` | `diary/data/diaries.enc.json`（**明文 `diaries.json` 会被删除**） | `diary/media/<basename>.enc` |

---

## 3. 生产构建 & GitHub Pages 发布设置

```bash
node tools/build-site.mjs --webdav     # CI 用（从坚果云现拉）
node tools/build-site.mjs --local      # 用本机坚果云目录组装 _site/（自查）
```

**Pages 设置（必做一次）**：仓库 → `Settings` → `Pages` → `Build and deployment` →
**Source 必须选 `GitHub Actions`**（不是 `Deploy from a branch`）。
选 Branch 的话页面会是仓库里的源码，而不是构建出来的 `_site`（`diary/data` 被 gitignore，站点里根本不会有点赞的数据）。

首次部署时 Actions 会自动创建 `github-pages` environment（workflow 里已声明）；如果环境要求审批，去 `Settings → Environments → github-pages` 关掉 required reviewers，否则 deploy 会一直卡在 waiting。

workflow 触发器：push 到 main、cron 每 2 小时、手动 `workflow_dispatch`。
权限：`contents: read`、`pages: write`、`id-token: write`；`concurrency: group: pages`。
**整个流程没有任何 commit / push 步骤。**

### 缺 secrets 时的降级（不会挂）

| 情况 | 行为 |
| --- | --- |
| 没配 `JIANGUO_USER` / `JIANGUO_PASS` | 跳过日记数据，照常发布静态站（`/diary/` 显示「暂无日记」空态），**退出码 0** |
| 没配 `DIARY_PASSWORD` | 同上跳过，并警告：生产构建不允许输出明文日记 |
| 凭据/网络出错（401、404、超时等） | **构建失败**（退出码 1）→ Actions 里能看见红色，旧版本继续在线 |

> 第二条是本仓库主动加的护栏：方案 B 的前提是「对外只有密文」。若确实想公开明文日记，得显式设 `DIARY_ALLOW_PLAINTEXT=1` 覆盖。

---

## 4. GitHub Secrets 配置

`Settings` → `Secrets and variables` → `Actions` → `New repository secret`：

| 名字 | 值从哪来 | 必需 |
| --- | --- | --- |
| `JIANGUO_USER` | 坚果云**登录邮箱**（和手机 App 里 WebDAV 配置的账号一致） | 是 |
| `JIANGUO_PASS` | 坚果云**应用密码**（见下一节，不是登录密码） | 是 |
| `DIARY_PASSWORD` | 自己想一个强密码（建议 ≥ 12 位，含大小写/数字/符号）。这是**网页上输的那个密码**，也是图片的加密密钥来源 | 是 |
| `DIARY_WEBDAV_DIR` | WebDAV 上的目录，默认 `我的坚果云/SwashbucklerDiary`。不确定就先留空/不建，用 `--list` 查 | 否 |

可选环境变量（一般不用配）：`DIARY_WEBDAV_URL`（默认 `https://dav.jianguoyun.com/dav/`）、`DIARY_INCLUDE_PRIVATE=1`、`DIARY_ALLOW_PLAINTEXT=1`。

本机也可以不配环境变量，直接写在被 gitignore 的 `tools/config.json`（参照 `config.example.json`）：

```json
{
  "password": "你的密码",
  "localDir": "C:/Users/jiale/Nutstore/1/SwashbucklerDiary",
  "webdav": { "url": "https://dav.jianguoyun.com/dav/", "user": "you@example.com", "pass": "应用密码", "dir": "我的坚果云/SwashbucklerDiary" }
}
```

---

## 5. 坚果云应用密码怎么生成

1. 浏览器登录 https://www.jianguoyun.com/
2. 右上角头像 → **账户信息** → **安全选项**
3. 找到 **第三方应用管理**（“添加应用密码”/“应用密码”）→ **添加应用**
4. 名称随便填（例如 `jialejunzi-diary-site`），生成一串密码 → 复制
5. 这串就是 `JIANGUO_PASS`。**它只显示一次**，丢了就重新添加一个。

同时确认 WebDAV 服务已开启（同一页有「WebDAV」开关/说明），服务器地址就是 `https://dav.jianguoyun.com/dav/`。

自检命令（本机能连就能在 CI 里跑）：

```bash
# 列出 WebDAV 根目录，确认账号密码和目录名
JIANGUO_USER=you@example.com JIANGUO_PASS='应用密码' node tools/sync-diary.mjs --webdav --list
```

---

## 6. 手机端：怎么备份 / 多久会更新

**备份路径**：侠客日记 → **我的** → **备份** → 顶部标签切到 **WebDAV** → **上传**。

- 备份文件名形如 `SwashbucklerDiaryBackup_20261030202537_v1.31.5.zip`，工具总是取**时间戳最新**的那个（不依赖列表顺序）。
- **多久更新**：Actions 每 2 小时跑一次（cron `17 */2 * * *`），加上排队时间，通常 **≤ 2 小时**后网站上能看到新日记。
- **想立刻更新**：仓库 → `Actions` → `build-and-deploy` → `Run workflow`（`workflow_dispatch`）。

---

## 7. 图片资源（源码调研结论，已逐条对源码求证）

### 现状：样本里为什么没有图片

手机端 `settings.json` 里 `WebDAVCopyResources` 当前是 **`false`**，所以备份 zip 里**只有** `SwashbucklerDiary.db3`、`settings.json`、`version.json`，一个图片条目都没有。而数据库里仍有 24 个 `appdata/Image/*.png|jpg` 引用（正文里是 `![](appdata/Image/<sha256>.png)`）——于是生成结果里这些媒体全是 `exists: false`，前端会显示「图片未同步」占位而不是裂图。

样本实测：`python -m zipfile -l SwashbucklerDiaryBackup_20261030202537_v1.31.5.zip` 只有 3 个条目（数据库、settings、version），无 `appdata/`。

### 手机端打开哪个开关

备份页里有个开关：

- 中文界面：**「包含媒体文件」**
- 英文界面：`Include media files`
- 对应配置项：`Setting.WebDAVCopyResources`

**操作路径**：侠客日记 → **我的** → **备份** → 顶部标签切到 **WebDAV** → 找到 **「包含媒体文件」** 开关并打开 → **再点一次「上传」**。

> 开关只影响**之后**的上传，所以必须再上传一次备份，zip 里才会带上图片。

### 打开之后，WebDAV 上的 zip 目录结构

zip 根目录 = 导出临时目录，资源按 **uri 原样**放进去：

```
SwashbucklerDiaryBackup_<yyyyMMddHHmmss>_v<x.y.z>.zip
├─ SwashbucklerDiary.db3          # SQLite 库
├─ settings.json                  # App 设置（含 WebDAVCopyResources）
├─ version.json                   # 版本 / 备份时间
└─ appdata/                       # ← 打开开关后才出现
   ├─ Image/<sha256>.png|jpg      # 日记正文 ![..](appdata/Image/xxx) 引用的图
   ├─ Audio/<sha256>.<ext>        # 录音
   ├─ Video/<sha256>.<ext>        # 视频
   └─ Avatar/<头像文件名>          # 同一次导出也会带上手机端头像
```

注意：**WebDAV 上的 zip 是一个文件**，不会把 `appdata/` 解压成目录树；目录结构是在 zip 内部。本机之所以看到 `C:\Users\jiale\Nutstore\1\SwashbucklerDiary\` 下只有 zip，也是这个原因。

`ResourceModel.ResourceType` 是枚举下标：`1=Image`、`2=Audio`、`3=Video`（样本里 24 条全是 `1`）。

### 源码依据（原始文件 URL，均已 curl 验证 HTTP 200）

固定 commit：`f45df93ddc417b3a27b2315b5855c03fe7e47e3d`（`main`，2026-10-17）

| 结论 | 源码位置 |
| --- | --- |
| `copyResources=true` 才拷贝资源，随后 `ZipFile.CreateFromDirectory(outputFolder, zipFilePath)`（zip 根即导出目录） | [`DiaryFileManager.cs` L90–L124](https://github.com/Yu-Core/SwashbucklerDiary/blob/f45df93ddc417b3a27b2315b5855c03fe7e47e3d/src/SwashbucklerDiary.Rcl/Services/DiaryFileManager/DiaryFileManager.cs#L90-L124) |
| 资源输出路径 = `Path.Combine(outFolder, uri)` → **zip 根 + uri 原样**，即 `appdata/Image/xxx.png` | [`DiaryFileManager.cs` L258–L279](https://github.com/Yu-Core/SwashbucklerDiary/blob/f45df93ddc417b3a27b2315b5855c03fe7e47e3d/src/SwashbucklerDiary.Rcl/Services/DiaryFileManager/DiaryFileManager.cs#L258-L279) |
| 备份文件名格式 `SwashbucklerDiaryBackup_yyyyMMddHHmmss_v{版本}.zip` | [`DiaryFileManager.cs` L375–L385](https://github.com/Yu-Core/SwashbucklerDiary/blob/f45df93ddc417b3a27b2315b5855c03fe7e47e3d/src/SwashbucklerDiary.Rcl/Services/DiaryFileManager/DiaryFileManager.cs#L375-L385) |
| 开关读的就是 `Setting.WebDAVCopyResources`，并传给 `ExportDBAsync(includeDiaryResources)` | [`WebDAVBackupsPage.razor.cs` L45 / L140](https://github.com/Yu-Core/SwashbucklerDiary/blob/f45df93ddc417b3a27b2315b5855c03fe7e47e3d/src/SwashbucklerDiary.Rcl.Hybird/Pages/Backups/WebDAVBackups/WebDAVBackupsPage.razor.cs#L45) |
| 开关 UI 与文案 key（`Include media files`） | [`WebDAVBackupsPage.razor` L78–L93](https://github.com/Yu-Core/SwashbucklerDiary/blob/f45df93ddc417b3a27b2315b5855c03fe7e47e3d/src/SwashbucklerDiary.Rcl.Hybird/Pages/Backups/WebDAVBackups/WebDAVBackupsPage.razor#L78-L93) |
| 中文文案「包含媒体文件」 | [`zh-CN.json`](https://github.com/Yu-Core/SwashbucklerDiary/blob/f45df93ddc417b3a27b2315b5855c03fe7e47e3d/src/SwashbucklerDiary.Rcl/wwwroot/i18n/zh-CN.json) |
| 虚拟目录名常量 `appdata` | [`AppFileSystem.cs` L5](https://github.com/Yu-Core/SwashbucklerDiary/blob/f45df93ddc417b3a27b2315b5855c03fe7e47e3d/src/SwashbucklerDiary.Rcl/Essentials/AppFileSystem/AppFileSystem.cs#L5) |
| 媒体目录映射 `Assets/<Image\|Audio\|Video>`，`/appdata` 路由到 `Assets` | [`MediaResourceManager.cs` L52–L58](https://github.com/Yu-Core/SwashbucklerDiary/blob/f45df93ddc417b3a27b2315b5855c03fe7e47e3d/src/SwashbucklerDiary.Rcl/Services/MediaResourceManager/MediaResourceManager.cs#L52-L58) |
| `MediaResource` 枚举顺序（1=Image、2=Audio、3=Video） | [`MediaResource.cs`](https://github.com/Yu-Core/SwashbucklerDiary/blob/f45df93ddc417b3a27b2315b5855c03fe7e47e3d/src/SwashbucklerDiary.Shared/Enum/MediaResource.cs) |
| 备份页两个标签 `Local backup` / `WebDAV` | [`BackupsPageBase.razor.cs` L11–L15](https://github.com/Yu-Core/SwashbucklerDiary/blob/f45df93ddc417b3a27b2315b5855c03fe7e47e3d/src/SwashbucklerDiary.Rcl/Pages/Mine/Backups/BackupsPageBase.razor.cs#L11-L15) |

> 调研方式说明：本机 `web_fetch` 被环境的 DNS 拦下（`github.com` 解析到 `198.18.0.x` 假 IP，工具拒绝访问），改用 `curl` 走 GitHub API + `git clone --depth 1` 拿到真实源码逐行核对，再把上表 8 个原始 URL 逐个 curl 验证返回 200 才写进本文。没有凭印象的内容。

打开开关后建议复查一次：

```bash
python -m zipfile -l "C:/Users/jiale/Nutstore/1/SwashbucklerDiary/SwashbucklerDiaryBackup_xxx.zip" | grep appdata
# 应能看到若干 appdata/Image/... 条目
```

---

## 8. 加密格式（给前端 A 端对齐用）

### 主密钥

```
key = PBKDF2-SHA256(password, salt, iterations=200000, dkLen=32)
```

`salt`（16B）和 `iterations` **取自 `diaries.enc.json`**，不要自己另生成 salt——图片用的是同一把主密钥。

### 文本：`diary/data/diaries.enc.json`

```json
{
  "schema": 1,
  "enc": "AES-256-GCM",
  "kdf": "PBKDF2-SHA256",
  "iterations": 200000,
  "salt": "base64(16B)",
  "iv": "base64(12B)",
  "ciphertext": "base64(AES-GCM 密文 || 16B authTag)",
  "hint": { "count": 171, "generatedAt": "2026-10-30T20:25:37+08:00" }
}
```

明文 = 契约第二节整份 JSON 的 UTF-8 字节（`count`/`generatedAt` 与 `hint` 一致）。`ciphertext` 是 `密文||tag`，WebCrypto 的 `subtle.decrypt` 直接吃这个，**不要再单独切 tag**。

### 图片：`diary/media/<basename>.enc`

```
文件字节 = iv(12B, 随机) || AES-256-GCM 密文 || authTag(16B)
```

- 同一把主密钥；**每个文件独立随机 iv**（所以每次内容变了都会重新加密）。
- 前端做法：取前 12B 当 iv，剩下全部当 `ciphertext`（含末 16B tag）交给 `subtle.decrypt({name:'AES-256-GCM', iv}, key, 密文)`，得到 Blob 再 `URL.createObjectURL` 换掉 `<img src=".../*.enc">`；按 URL 缓存 objectURL，避免重复解密。
- 明文模式下图片是原名 `diary/media/<basename>`，`media[].encrypted=false`、不加 `.enc`。
- `entries[].media[].encrypted` 与顶层 `doc.encrypted` 永远一致，可用来判断该不该解密。

### 幂等 / 安全取舍

- 内容没变 → 复用已有 `salt` + `iv`，密文字节完全相同 → **不重写文件、mtime 不变**（CI 判断「无变更」用得上）。
- 内容变了 → 换**新的随机 iv** 再写，避免同一密钥下 GCM nonce 复用。
- 图片同理：已有 `.enc` 若能解回同样的字节就复用，否则用新 iv 重写。

---

## 9. cron 频率 vs 坚果云 WebDAV 配额

每次构建的 WebDAV 用量是固定的：**1 次 `PROPFIND`（列目录）+ 1 次 `GET`（下整个 zip）**。

- 当前 `17 */2 * * *`：每天 12 次 → 每月约 **360 次请求 + 360 次 zip 下载**。
- 坚果云免费版对 WebDAV 的请求数/流量是有限额的（具体额度以官网为准，会调整）。图片开关打开后 zip 会明显变大（每张图都是原图），下载流量按 zip 尺寸成倍增长。
- **省配额的做法**：日记不是实时内容，把 cron 改疏即可，例如
  - 每天 2 次：`17 3,15 * * *`
  - 每天 1 次：`17 3 * * *`
  - 只手动：删掉 `schedule:`，保留 `workflow_dispatch`，想更新就点一次 `Run workflow`。
- 反过来，如果 Actions 日志里出现 `429` / `507` / 403，先把 cron 调疏。

---

## 10. 常见报错排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `PROPFIND 401` | 账号或密码不对 | 坚果云**必须用「应用密码」**，不是登录密码（第 5 节） |
| `PROPFIND 404` | 目录不对 | `node tools/sync-diary.mjs --webdav --list` 看根目录真实名字，再设 `DIARY_WEBDAV_DIR` |
| `PROPFIND 405` | 服务器地址结尾少了 `/` | `DIARY_WEBDAV_URL` 保持 `https://dav.jianguoyun.com/dav/` |
| `下载到的内容不是 zip` | 被网关/登录页替换 | 同 401/404，检查凭据与目录 |
| `下没有 SwashbucklerDiaryBackup_*.zip` | 还没备份过，或目录写错 | 手机上先「上传」一次 |
| 图片全是 `exists:false` | `WebDAVCopyResources=false` | 打开「包含媒体文件」再上传一次（第 7 节） |
| `跳过日记数据：缺少 JIANGUO_USER / JIANGUO_PASS` | secrets 没配 | 配 Secrets（第 4 节），或本机写 `tools/config.json` |
| `跳过日记数据：缺少 DIARY_PASSWORD` | 没设密码（护栏） | 设 `DIARY_PASSWORD`；确实要明文才设 `DIARY_ALLOW_PLAINTEXT=1` |
| `当前 Node（vXX）没有内置 node:sqlite` | Node < 22.5 | 升到 Node 24 |
| 页面一直转圈 / 空态 | 数据文件 404 | 看 `_site/diary/data/` 有没有文件；CI 里看 build 日志是不是「跳过日记数据」 |
| `npm ci` 报 lockfile 不同步 | `package.json` 改过 | 在 `tools/` 跑 `npm install --package-lock-only` 后提交 `package-lock.json` |
| deploy 卡住 waiting | `github-pages` environment 有审批 | `Settings → Environments → github-pages` 关掉 required reviewers |
| 页面是源码不是站点 | Pages Source 选错了 | 改成 **GitHub Actions**（第 3 节） |

---

## 11. 自测记录（真实样本，命令 + 关键输出）

样本：`C:\Users\jiale\Nutstore\1\SwashbucklerDiary\SwashbucklerDiaryBackup_20261030202537_v1.31.5.zip`
环境：Node v24.22.1 / npm 11.19.1 / Python 3.15.0 / Windows

### 11.1 `node:sqlite` 直接读样本 db3（环境验证）

```
$ node -e "const {DatabaseSync}=require('node:sqlite'); ..."
TABLES: DiaryModel, DiaryResourceModel, DiaryTagModel, LocationModel, LogModel, ResourceModel, TagModel, UserAchievementModel, UserStateModel, sqlite_sequence
DIARY_COUNT: {"c":171}
```

### 11.2 真实样本 · 明文模式 + 契约校验

```
$ node tools/sync-diary.mjs --plain --local --dir "C:/Users/jiale/Nutstore/1/SwashbucklerDiary" --out <SCRATCH>/out-plain
备份版本：v1.31.5｜备份时间：2026-10-30T20:25:37+08:00｜库内日记：171 篇（Private 0 篇）

── 摘要 ──
日记：171 篇（已排除 Private）｜首次生成
媒体：引用 24 个 · 本次写入 0 · 复用 0 · 缺失 24（zip 里没有这些资源：手机端未开启「包含媒体文件」）
标签：收藏(2)｜词数合计 11195

$ node check-doc.mjs <SCRATCH>/out-plain/diary/data/diaries.json 171
PASS  schema === 1  → schema=1
PASS  count === entries.length  → 171 / 171
PASS  entries 数 = 171  → 实际 171
PASS  按 createTime 严格倒序
PASS  契约字段齐全
PASS  createTime 格式 YYYY-MM-DD HH:mm:ss  → 0 条不符
PASS  date/year/month/time 派生正确  → 0 条不符
PASS  title 截断 <= 40 字符  → 0 条超长
PASS  excerpt <= 120 字  → 0 条超长
PASS  words 为非负整数  → 0 条异常
PASS  markdown 无残留 appdata 引用  → 0 处
PASS  media[].file 指向 media/  → 0 个异常
PASS  media[].encrypted / exists 为布尔
PASS  media[].encrypted 与 doc.encrypted 一致  → doc.encrypted=false
PASS  media[].file 后缀与模式一致
PASS  换行已统一为 \n（无 \r）  → 0 条含 \r
PASS  JSON 未把中文转义为 \uXXXX
PASS  tags 统计与 entries[].tags 一致  → 顶层合计 2｜带标签条目 2
全部通过 ✓
```

首条/末条时间（倒序正确）：`2026-10-29 22:25:35` → `2026-09-05 19:27:45`。

### 11.3 幂等（明文模式，连跑两遍）

```
$ sha256sum <...>/diaries.json   # 第 1 遍
ac4c4431c4a078b028142b8b68a34318e9d19d3d2431784869fe21fac67c18e0
$ node tools/sync-diary.mjs --plain --local --dir ... --out <SCRATCH>/out-plain
日记：171 篇（已排除 Private）｜新增 0 / 删除 0 / 变更 0
输出：无写入（内容未变）｜未变 1 个
$ sha256sum <...>/diaries.json   # 第 2 遍
ac4c4431c4a078b028142b8b68a34318e9d19d3d2431784869fe21fac67c18e0
内容一致: 是     mtime 未变: 是
```

### 11.4 幂等 + 明文删除（密码模式，连跑两遍）

```
$ node tools/sync-diary.mjs --local --dir ... --out <SCRATCH>/out-enc     # 先用明文占位
密码模式：已删除明文 diary\data\diaries.json，只保留密文
输出：写入 1 个｜删除 1 个
  - ...\out-enc\diary\data\diaries.json（密码模式：明文不得留在仓库）
明文是否已删除: 是

$ node tools/sync-diary.mjs --local --dir ... --out <SCRATCH>/out-enc     # 第 2 遍
输出：无写入（内容未变）｜未变 1 个
密文一致: 是     mtime 未变: 是
hash=c5f1f7f9254a75b359fa40ce12b8b2d0b2169d2f88e92d469baa0a980ca22d73
```

### 11.5 独立解密验证（WebCrypto，另一套实现）

```
$ node tools/verify-decrypt.mjs --in _site/diary/data/diaries.enc.json
✓ diaries.enc.json 解密成功
  迭代 200000｜salt 16B｜iv 12B｜密文 162659 B
  明文字节：162643 B｜sha256：0de39eae414cb6af9f77b26ef04af34372be937f3c8ce12e1acc5d563227b725
  schema=1 count=171 encrypted=true source=SwashbucklerDiary v1.31.5
  hint.count=171 generatedAt=2026-10-30T20:25:37+08:00（与正文一致：是）
  字段缺失：无｜按 createTime 严格倒序：是｜count === entries.length：是
  markdown 残留 appdata 引用：0 处（应为 0）
  media[] 保留原始 uri：25 个｜指向 .enc 的：25 个（密码模式应全部为 .enc）
```

### 11.6 夹具（3 篇含 1 篇 Private + 1 张真图）· 明文模式

夹具由 `python zipfile + sqlite3` 独立构造（含 1 张手写 PNG），避免"用生成器自己的逻辑验证生成器"。

```
$ node tools/sync-diary.mjs --plain --zip <FIX>/SwashbucklerDiaryBackup_20260105090807_v1.31.5.zip --out <SCRATCH>/out-fix
日记：2 篇（已排除 Private）｜首次生成       ← 3 篇里排除了 Private
媒体：引用 1 个 · 本次写入 1 · 复用 0 · 缺失 0
  + .../diary/media/ee352d1f...b0.png
  + .../diary/data/diaries.json

$ node check-doc.mjs <...>/diaries.json 2
...（19 项全 PASS）
条目 2｜媒体引用 1（exist 1）｜标签 {"收藏":1}

Private 泄漏检查：0 处（未泄漏）✓
原图   sha256=ee352d1f9d465a839dc61c69d696e3790e5aa298ae647b7f043ddcaf5dfd39b0
产物   sha256=ee352d1f9d465a839dc61c69d696e3790e5aa298ae647b7f043ddcaf5dfd39b0
字节一致: 是

markdown: "## 夹具 · 带图片的公开日记\n\n这是**粗体**和 `code`，还有一张图：\n\n![截图](media/ee352d1f...b0.png)\n\n- 列表项一\n- 列表项二\n"
media: [{"uri":"appdata/Image/ee352d1f...b0.png","file":"media/ee352d1f...b0.png","exists":true,"encrypted":false}]
tags: ["收藏"]  mood/weather/location: ["","晴天","家"]  top: true
```

`--include-private` 时条目数 3，Private 正文正常出现（仅本机自看时用）。

### 11.7 图片加密往返（密码模式，逐字节比对）

```
$ node tools/sync-diary.mjs --zip <FIX>/...090807....zip --out <SCRATCH>/out-fixpw
  + .../diary/media/ee352d1f...b0.png.enc
  + .../diary/data/diaries.enc.json

$ node tools/verify-decrypt.mjs --in .../diaries.enc.json
✓ 解密成功｜迭代 200000｜salt 16B｜iv 12B
  markdown 残留 appdata 引用：0 处
  media[] 保留原始 uri：1 个｜指向 .enc 的：1 个（密码模式应全部为 .enc）

$ node tools/verify-decrypt.mjs --media .../media/ee352d1f...b0.png.enc --out <SCRATCH>/fixpw-image.png
✓ 媒体解密成功
  明文字节：74 B｜sha256：ee352d1f9d465a839dc61c69d696e3790e5aa298ae647b7f043ddcaf5dfd39b0
  iv(前12B, hex)：7d8986583bcb5335ff4d1227
  GCM tag(末16B, hex)：6b11608a867021e17ff021e049e3ff8b

解密图 sha256=ee352d1f9d465a839dc61c69d696e3790e5aa298ae647b7f043ddcaf5dfd39b0
原图   sha256=ee352d1f9d465a839dc61c69d696e3790e5aa298ae647b7f043ddcaf5dfd39b0
字节一致: 是
密文大小: 102 B（原图 74 B + 12 iv + 16 tag = 102）✓

图片密文幂等（第 2 遍）：媒体：引用 1 个 · 本次写入 0 · 复用 1 · 缺失 0
图片密文一致: 是｜mtime 未变: 是
```

### 11.8 空数据（0 篇）不崩

```
$ node tools/sync-diary.mjs --plain --zip <FIX>/SwashbucklerDiaryBackup_20260106000000_v1.31.5.zip --out <SCRATCH>/out-empty
日记：0 篇（已排除 Private）｜首次生成
媒体：引用 0 个 · 本次写入 0 · 复用 0 · 缺失 0
标签：无｜词数合计 0
退出码=0
条目 0｜媒体引用 0（exist 0）｜标签 {}
全部通过 ✓
```

### 11.9 生产入口 `build-site.mjs`（方案 B 验收）

```
$ node tools/build-site.mjs --local
静态站文件：复制 7 个
  · CNAME · diary/diary.css · diary/diary.js · diary/index.html
  · diary/vendor/marked.LICENSE.txt · diary/vendor/marked.min.js · index.html

── _site 摘要 ──
文件总数：8 个｜合计 315.4 KB
日记数据：diary\data\diaries.enc.json（171 篇｜密文（密码模式））
CNAME：已包含

$ find _site -type f | sort
_site/CNAME
_site/diary/data/diaries.enc.json        ← 静态站文件 + 密文数据 同时在
_site/diary/diary.css
_site/diary/diary.js
_site/diary/index.html
_site/diary/vendor/marked.LICENSE.txt
_site/diary/vendor/marked.min.js
_site/index.html

$ git status --porcelain -uall          ← 仓库里看不到任何日记数据
 M index.html
?? .github/workflows/deploy.yml
?? .gitignore
?? diary/diary.css
?? diary/diary.js
?? diary/index.html
?? diary/vendor/marked.LICENSE.txt
?? diary/vendor/marked.min.js
?? tools/.gitignore
?? tools/build-site.mjs
?? tools/package-lock.json
?? tools/package.json
?? tools/sync-diary.mjs
?? tools/sync-diary.ps1
?? tools/verify-decrypt.mjs

$ git status --porcelain --ignored=matching -uall | grep '^!!'
!! _site/
!! diary/data/
!! diary/media/
!! tools/config.json
```

### 11.10 缺 secrets 降级（退出码 0，静态站照发）

```
$ node tools/build-site.mjs --webdav
⚠ 跳过日记数据：缺少 JIANGUO_USER / JIANGUO_PASS
  静态站照常发布，/diary/ 会显示「暂无日记」空态。
  ...
文件总数：7 个｜合计 103.3 KB
日记数据：已跳过（缺少 JIANGUO_USER / JIANGUO_PASS）
退出码=0
diary/data 下有无数据文件: 0 个（0=空态）
```

```
$ node tools/build-site.mjs --webdav --plain        # 模拟 CI 没有 DIARY_PASSWORD
日记数据：已跳过（缺少 DIARY_PASSWORD（生产构建不允许输出明文日记））
退出码=0
日志里有 PROPFIND 网络请求吗: 0        ← 连网络请求都不发
```

```
$ JIANGUO_USER=... JIANGUO_PASS=dummy node tools/build-site.mjs --webdav
✗ build-site 失败：PROPFIND 401 Unauthorized ... — 账号或应用密码错误（坚果云要用「应用密码」，不是登录密码）
退出码=1                                ← 真错误要显式失败，不静默
```

### 11.11 Windows 一键脚本

```
$ powershell -NoProfile -ExecutionPolicy Bypass -File tools/sync-diary.ps1 -Build
最新备份：SwashbucklerDiaryBackup_20261030202537_v1.31.5.zip（51.4 KB，10/30/2026 20:25:37）
...
产物目录：F:\AI\Workspace\dsh\jialejunzi-site\_site
文件总数：8 个｜合计 315.4 KB
▶ 检查日记数据是否会被 git 提交 ...
  ✓ 干净：diary/data、diary/media、_site 都不会进 git
退出码=0
```

### 11.12 仓库内搜不到明文日记

手写 grep 示例时要小心：**把引号里的内容换成你自己日记里的一小段；这条命令本身不要写真实原文**——否则明文就又被写进仓库了（本项目的文档确实踩过这个坑，所以才有了下面那个守卫脚本）。

```bash
# 预期输出为空（示例里的占位串当然搜不到）
git grep -I -n "某句只有你自己知道的日记原文" -- .
```

更省事也更可靠的办法：直接用仓库自带的守卫，它拿**真实数据**反查，不需要你手打原文：

```bash
$ node tools/check-plaintext-leak.mjs
真实数据：171 篇 → 散文型指纹 10858 个（窗口 10 字／含 ≥4 个中日韩字符）
待扫描文件：20 个（git ls-files -co --exclude-standard）

✓ 干净：未发现任何真实日记原文片段
```

守卫的工作原理与用法：

- 把真实日记的 `title`/`excerpt`/`markdown` 归一化后切成 10 字窗口当"指纹"，再扫「将会被提交的文件」（`git ls-files -co --exclude-standard`），专抓"把某句日记原文抄进文档/代码"这类事故。只保留含 ≥4 个中日韩字符的窗口——否则 `jialejunzi`、`----------`、`blockquote` 这类通用串会误报一大片；再减去既有站点文件的词汇（`README.md`/`CNAME`/`index.html`/`diary/*`），那些属于站点自有词汇。
- 输出默认**脱敏**（只给文件、行号、片段长度），因为公开仓库的 CI 日志是公开的，守卫不该在日志里再漏一遍；本机调试要看原文才加 `--show`（确认后别把输出贴进任何文件）。
- 没有密码、或还没生成 `diary/data/diaries.enc.json` 时，它会打印「跳过」并**退出 0**，不会卡住构建。
- 发现泄漏时退出码 1，方便接进 CI。

防回归建议：这条命令可以随时手动跑；它是纯只读的，不会改任何文件。

### 11.13 模式切换卫生（明文 ↔ 密码）

```
明文模式后 media/: ee352d1f...b0.png
切到密码模式:
  - .../diary/media/ee352d1f...b0.png（密码模式不允许明文媒体留在仓库）
  - .../diary/data/diaries.json（密码模式：明文不得留在仓库）
切到密码模式后 media/: ee352d1f...b0.png.enc      明文媒体是否已清除: 是
切回明文模式后 media/: ee352d1f...b0.png          .enc 是否已清除: 是
```

---

## 12. 已知限制与遗留风险

1. **本地预览的密码 ≠ 线上密码**：`tools/config.json` 里那个密码只用于本机预览（该文件被 gitignore）。线上必须用 `secrets.DIARY_PASSWORD`。两者不同时，切换后图片 `.enc` 会在下次构建按新密钥重做（已自测通过）。
2. **CI 每次构建都换 salt**：`_site` 每次清空重建，所以密文的 salt/iv 每次都是新的。这是安全的（salt 只需按密码唯一，不复用也无妨），但意味着**同一份明文在不同构建之间密文不同**——不要拿密文做 diff 判断，判断数据有没有变要看解密后的内容。
3. **明文模式是真实的泄漏风险**：`--plain` / `DIARY_ALLOW_PLAINTEXT=1` 会把日记正文放进公网产物。除非确实要公开，别开。
4. **图片会显著增大产物**：图片是手机原图，开「包含媒体文件」后 zip 与 Pages 产物都会大很多。GitHub Pages 有单站点容量与单文件大小限制，图片特别多时要考虑压缩（本例 24 张图目前都还没同步）。
5. **媒体文件名扁平化**：`appdata/Image|Audio|Video/<sha256>.<ext>` 统一落到 `diary/media/<basename>`，靠 sha256 去重。理论上跨类型可能撞名，实际可忽略。
6. **`media[].exists=false` 必须由前端兜住**：样本里 24 个引用全部没有文件，A 端要显示「图片未同步」占位。
7. **坚果云 WebDAV 限额以官网为准**：本文只给出我们的调用量估算（第 9 节），没有引用具体额度数字。
8. **旧 workflow 已作废**：task-2 里最初设想的 `sync-diary.yml`（构建后 commit 回仓库）按方案 B **不实现**，请不要再加回来——任何把日记数据写进仓库的做法都会破坏"仓库里只有代码"这个前提。
