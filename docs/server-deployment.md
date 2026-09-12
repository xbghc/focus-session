# 后端部署与设备同步

后端使用 Node.js、PostgreSQL 和持久文件目录。数据库保存用户、设备 Token 哈希、结构化记录、同步变更和资源索引；正文、图片、附件作为文件保存。后端不会抓取原网站或调用模型，正常运行不需要主动访问外部互联网。客户端继续独立保存业务数据，服务器不可达时可继续阅读和复习，下次连接补同步。

## 用 Docker Compose 部署

需要 Docker Engine 和 Compose v2。仓库根目录的 `compose.yaml` 启动两个容器：`server` 和 `postgres`；数据库不暴露主机端口，两个命名卷分别保存数据库和文章文件。

1. 把 `compose.yaml` 和 `.env.example` 放入服务器上的同一个目录，将 `.env.example` 复制为 `.env`。
2. 将 `FOCUS_SERVER_IMAGE` 改为已发布的 `ghcr.io/<仓库所有者>/focus-session-server:<版本>`，或固定到镜像摘要 `@sha256:...`。镜像在新的 `v*` 标签触发 Server image 工作流成功后才存在，旧的 GitHub Release 不会自动补发镜像。
3. 用 `openssl rand -hex 32` 生成数据库密码，填入 `POSTGRES_PASSWORD`。使用十六进制避免连接 URL 中的特殊字符转义问题。
4. 按下文配置 HTTPS 入口和客户端来源，再启动服务。

```bash
docker compose config --quiet
docker compose pull
docker compose up -d
docker compose ps
docker compose logs --tail=100 server
```

后端启动时执行版本化数据库迁移。容器以非 root 用户运行，程序目录只读，文件写入 `/data` 对应的持久卷。若替换成宿主机绑定目录，需要让 UID 1000 可读写该目录。

默认只监听主机 `127.0.0.1:8787`，由主机上的 HTTPS 反向代理转发到它。NAS 的代理若在另一个容器中，应让代理接入同一个 Docker 网络并访问 `server:3000`，或明确配置可达的绑定地址。直接供局域网或 VPN 访问时可以设置 `BIND_ADDRESS` 为相应网卡地址。正式客户端使用 HTTPS；仅本机开发地址允许明文 HTTP。

反向代理保留 `Authorization` 请求头，允许 PUT/POST/GET/OPTIONS，JSON 请求上限至少 16 MiB，文件请求上限至少 32 MiB；读写超时需要覆盖慢速移动网络上的上传。只转发后端 API，不把文章文件目录公开为静态目录。客户端填写根地址，例如 `https://sync.example.com`，不附加 `/v1`。

`CORS_ORIGINS` 是逗号分隔的准确来源列表，不带路径或末尾斜杠。安卓 App 来源是 `https://appassets.androidplatform.net`，模板已包含；浏览器预览、扩展或不同宿主若发送 `Origin`，按需要追加实际来源，例如 `chrome-extension://<扩展 ID>`。服务端不接受通配符来源。原生客户端未发送 `Origin` 的请求仍须通过 Token 鉴权。

首次发布的 GHCR 包可能是私有的：部署者可以在 GitHub 的包设置中将其公开，或在拉取机器上使用具有 `read:packages` 权限的凭证登录 GHCR。该凭证仅用于下载镜像，与客户端同步 Token 无关。发布鉴权与包可见性见 [GitHub Container registry 文档](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)。

## 创建账号和设备 Token

管理员命令直接访问数据库，不需要公开注册页面或额外的管理 API。以下命令在 Compose 目录执行：

```bash
docker compose exec server npm run admin -- create-user alice
docker compose exec server npm run admin -- list-users
docker compose exec server npm run admin -- issue-token <userId> phone
docker compose exec server npm run admin -- list-tokens <userId>
docker compose exec server npm run admin -- revoke-token <tokenId>
```

`create-user` 创建用户并签发首个 Token；`issue-token` 为同一用户增加凭证。将命令输出的 Token 保存到密码管理器并填入对应设备。数据库只保存哈希，无法从 `list-tokens` 找回 Token 原文；遗失时重新签发。每台设备建议使用不同 Token，丢失设备时可以单独吊销。不要把命令输出、`.env` 或 Token 提交到仓库。

## 客户端连接

在插件和安卓的设置页打开「设备同步」，填写后端地址和该用户的 Token。先点击「测试连接」核对用户 ID 和服务器 ID，再点击「保存并启用同步」。测试不保存配置，也不上传阅读数据。

首次启用会合并本机已有记录和服务器上的账号数据。同步成功后，其他使用同一账号的设备即可拉取记录。页面显示是否启用、待上传数量、上次成功时间和错误原因，可以手动触发「立即同步」。阅读与翻译设置按字段同步，包括两份黑名单、读完判定、专注阈值、续读位置和文章回顾开关；字号、应用更新偏好、模型配置、API Key、诊断日志和同步 Token 保留在本机。Token 不进入 JSON 导出。

- **暂停同步**：保留连接配置和待发送数据，本地继续记录。
- **断开连接**：删除本机保存的 Token，保留本机业务数据和账号绑定。
- **清除此设备记录**：断开同步、清除本地记录及绑定，保留普通设置与模型 API Key；不会请求删除服务器账号数据。
- **更换账号**：先导出本机备份，再清除此设备记录，最后连接新账号。已绑定数据不能直接切换到另一用户或另一服务器，避免误上传。

重新连接原账号会从服务器恢复记录。历史页主动删除文章会传播删除标记；这与清理单台设备的本地数据是两种操作。

划词删除会同步到其他设备；复习卡没有任何剩余来源时隐藏。如果另一台设备新增了同一词元的划词，保留该来源，卡片继续可用。无来源卡片的既有复习历史保留，日后再次划到同一词元时恢复原排期。

新版 JSON 导出包含可选的复习历史记录及调度基线。使用新版客户端导入后，重复导入或继续联网同步都按原事件 ID 去重；旧版文件只有卡片状态，会作为已有排期基线迁移，无法补造此前的每次评分。

设备本地数据、待发送操作和同步游标一起持久化；上传失败或进程退出后可以继续重试。服务端对操作 ID 去重，并在数据库事务中写入合并结果和有序变更。后端升级前后的客户端通过协议版本校验兼容性，不兼容时显示错误并保留本地数据。

## 文章文件与资源

文章内容由客户端上传，服务端不接收原网站 Cookie，也不会重新登录网页。文件按用户和内容哈希存储，数据库只记录相对存储键；不同用户之间不共享资源授权。上传先写临时文件，验证大小和 SHA-256 后才发布文件索引。下载需要同步 Token，客户端不指定磁盘路径。

保存和阅读文章的操作：

1. 在电脑浏览器中打开文章，完成网站登录并让正文、图片加载出来。
2. 点击插件弹出面板的「保存文章到同步库」。正文和能取得的图片先保存在本机，连接同步服务器后上传。
3. 保存结果若提示图片缺失，等原页面资源加载完成后重新保存；登录校验、防盗链、跨域限制或页面交互仍可能导致个别资源无法取得。
4. 手机同步后，在首页的「插件保存的文章」中打开条目。首次打开会下载正文和图片，页面会显示下载结果。
5. 页面显示「可离线阅读」后，已下载内容可在断网时继续使用。缺失图片会显示占位提示，恢复连接后重新打开重试。

同步文章清单不会提前下载整个文章库的资源；第一版在打开文章时下载。已有的普通链接解析缓存不会自动变成插件存档，文章回顾保存的正文文本可以独立同步。阅读器不会执行原站脚本，也不会为插件存档重新请求原网址；交互式网页不能保证完整复刻。

第一版保留同步变更、操作去重信息和删除标记，不按日期自动裁剪，以支持长时间离线的设备。文章文件不会因本机清理而被删除。不要手动删除文件卷中的单个文件；数据库里仍可能存在引用。长期运行需要根据实际数据增长安排备份和容量。

## 配置项

| 变量 | 默认或要求 |
| --- | --- |
| `DATABASE_URL` | 必填；Compose 自动构造，直接运行时填写 PostgreSQL 连接地址 |
| `HOST` / `PORT` | 直接运行默认 `0.0.0.0:8787`，容器内为 `0.0.0.0:3000` |
| `DATA_DIR` | 直接运行默认 `./data`，容器为 `/data` |
| `CORS_ORIGINS` | Compose 默认安卓 App 来源；多个来源用逗号分隔 |
| `MAX_JSON_BYTES` | 默认 16 MiB，请求 JSON 上限 |
| `MAX_BLOB_BYTES` | 默认 32 MiB，单文件上限 |
| `MAX_USER_BLOB_BYTES` | 默认 2 GiB，用户文件配额 |
| `FOCUS_SERVER_IMAGE` | Compose 必填，建议固定版本或摘要 |
| `POSTGRES_IMAGE` | Compose 默认 `postgres:17-alpine` |
| `POSTGRES_PASSWORD` | Compose 必填，首次创建数据库时使用 |
| `BIND_ADDRESS` / `HTTP_PORT` | Compose 默认 `127.0.0.1:8787` |

数据库已初始化后，改 `.env` 中的密码不会自动更改数据库角色密码；需要同时通过数据库管理方式修改。不要直接更换 PostgreSQL 的主版本镜像，主版本升级需要对应的数据库升级或导出恢复流程。

## 更新、备份与恢复

更新前备份数据库和文件卷，修改 `.env` 中的后端镜像版本后执行：

```bash
docker compose pull server
docker compose up -d server
docker compose ps
```

不要使用 `docker compose down -v` 更新；它会删除持久数据卷。数据库迁移可能不能被旧程序读取，回退前核对兼容性，必要时恢复与旧版本一起保存的备份。

下面是 Linux shell 下停止业务写入后的备份示例，备份期间不要执行修改数据的管理员命令：

```bash
mkdir -p backup
docker compose stop server
docker compose exec -T postgres pg_dump -U focus -d focus -Fc > backup/database.dump
docker compose run --rm --no-deps --entrypoint tar server -C /data -czf - . > backup/articles.tar.gz
docker compose start server
```

确认每条命令成功，单独保存 `.env`、Compose 配置及镜像版本/摘要。备份包含私人阅读内容和 Token 哈希，应保存在受保护位置。只备份数据库会丢失文章文件，只备份文件会丢失用户、引用和同步身份。

在**新建且为空的恢复环境**中，使用备份时的程序与 PostgreSQL 主版本：

```bash
docker compose up -d --wait postgres
docker compose exec -T postgres pg_restore -U focus -d focus --no-owner --exit-on-error < backup/database.dump
docker compose run --rm --no-deps -T --entrypoint tar server -C /data -xzf - < backup/articles.tar.gz
docker compose run --rm --no-deps server npm run admin -- rotate-server-id
docker compose up -d server
```

恢复旧备份后，已有设备可能持有比备份更新的同步游标。上面的 `rotate-server-id` 会为恢复后的数据库生成新服务器身份，使设备停止向回退的同步历史继续写入；必须在接受客户端连接前执行，并重启全部后端实例。

旧设备会提示服务器身份变化。先在各设备导出备份，确认尚未上传的记录已经保存，再清除此设备记录并连接恢复后的服务器，最后导入需要补回的本地记录。仅断开再连接不会解除旧身份绑定。JSON 备份不包含完整文章资源，因此尚未上传的文章内容也应先另行保存；已经上传的正文与图片从配套文件备份恢复。上线前使用测试设备核对账号、文章文件和新增记录同步。

## GitHub Actions 镜像发布

`.github/workflows/server.yml` 的行为如下：

- 推送 `main`、创建 PR 或手动运行：执行客户端与后端检查、带 PostgreSQL 的集成测试，构建 `linux/amd64` 和 `linux/arm64` 镜像，不发布。
- 推送 `v*` 标签：检查通过后发布到 `ghcr.io/<仓库所有者>/focus-session-server`。根目录和 `server/package.json` 的版本必须与标签一致。
- 发布标签包括版本号（例如 `0.3.5`）和 `sha-<完整提交 SHA>`；稳定版本额外更新 `latest`，预发布版本不更新 `latest`。
- 工作流使用最小范围的 `GITHUB_TOKEN` 包写权限，Actions 固定到完整提交 SHA。镜像摘要在成功运行的 Summary 中显示。

发布新版本时需要同步更新根目录和 `server/package.json` 及对应 lockfile；现有扩展/APK 发布流程仍由相同 `v*` 标签触发。正式服务器建议固定到版本或摘要，不自动追随 `latest`。

构建及拉取镜像需要联网，运行中的后端无需外网。完全离线服务器可在联网机器上拉取匹配目标 CPU 架构的后端和 PostgreSQL 镜像，通过 `docker save` 导出、传入服务器后 `docker load`，再用 `docker compose up -d --pull never` 启动。参考 [GitHub 发布镜像流程](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images) 和 [Docker 多平台构建](https://docs.docker.com/build/building/multi-platform/)。

## 本地开发

在仓库根目录安装客户端依赖，在 `server` 中安装后端依赖。Node.js 使用 22.14 或更新版本，准备一个独立 PostgreSQL 数据库后设置 `DATABASE_URL`：

```bash
npm ci
npm --prefix server ci
npm --prefix server run build
npm --prefix server run admin -- create-user developer
npm --prefix server start
```

后端测试用 `npm --prefix server test`。设置 `DATABASE_URL` 时会运行数据库集成测试，应指向专用测试库。容器构建可在仓库根目录运行 `docker build -t focus-session-server:dev .`，然后把该标签填入 Compose 的 `FOCUS_SERVER_IMAGE`。
