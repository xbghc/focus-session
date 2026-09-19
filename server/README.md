# Focus Session 同步后端

Node.js 22 + PostgreSQL，结构化数据保存在数据库，正文及图片保存在 `DATA_DIR` 的用户隔离目录。运行期间没有主动访问外网的功能。容器部署与 GHCR 发布说明见 [部署文档](../docs/server-deployment.md)。

## 开发运行

```sh
cd server
npm ci
npm run build
export DATABASE_URL=postgresql://focus:password@localhost:5432/focus
export DATA_DIR=./data
npm run admin -- create-user "My account"
npm start
```

服务启动和管理命令自动应用版本化迁移。诊断用的 `stats`、`check`、`show-record`、`usage` 见下文「诊断」。`create-user` 输出用户 ID、Token ID 和只显示一次的 Token；`issue-token <userId> [label]` 可为同一账号签发其他设备凭证，`revoke-token <tokenId>` 单独撤销。数据库只保存 Token 的 SHA-256 摘要。`list-users`、`list-tokens <userId>` 不返回 Token 或哈希。

## 配置

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| `DATABASE_URL` | 必填 | PostgreSQL 连接串 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `PORT` | `8787` | HTTP 端口 |
| `DATA_DIR` | `./data` | 持久文件根目录 |
| `CORS_ORIGINS` | `https://appassets.androidplatform.net` | 允许的完整 Origin，逗号分隔，不支持通配符 |
| `MAX_JSON_BYTES` | `16777216` | 单次 JSON 请求上限 |
| `MAX_BLOB_BYTES` | `33554432` | 单文件字节上限 |
| `MAX_USER_BLOB_BYTES` | `2147483648` | 单用户文件总大小上限 |

Android WebView 需允许 `https://appassets.androidplatform.net`。扩展发出带 Origin 的请求时，需加入其完整 `chrome-extension://<扩展 ID>`。不携带 Origin 的原生客户端仍须 Token 验证。生产访问在反向代理终止 HTTPS；代理限制请求大小、连接数和请求速率。数据库和文件目录不要对公网开放。

## HTTP 协议 v1

除 `GET /health` 和 CORS 预检外，所有请求必须携带 `Authorization: Bearer <token>`。用户身份只来自 Token，URL 和请求体不能选择其他用户。

| 接口 | 请求和结果 |
| --- | --- |
| `GET /health` | 返回 `200 {status:"ok",protocol:1}`；数据库不可用返回 503 |
| `GET /v1/info` | `{serverId,userId,userName,protocol:1}` |
| `POST /v1/sync/push` | `{deviceId,operations:[{opId,record}]}` → `{accepted:[opId],head}`，每批至多 200 条 |
| `GET /v1/sync/pull?cursor=0&limit=200` | `{records,cursor,hasMore}`，返回合并结果日志；最多 500 条、约 2 MiB（至少一条） |
| `GET /v1/sync/snapshot` | 创建不可变快照并返回第一页 `{token,head,records,cursor,hasMore,expiresAt}` |
| `GET /v1/sync/snapshot?token=…&cursor=…&limit=200` | 继续同一快照；快照完成后从 `head` 拉取增量 |
| `PUT /v1/blobs/<sha256>` | 原始字节，`Content-Type` 指定 MIME；成功返回 `{hash,size}` |
| `GET` / `HEAD /v1/blobs/<sha256>` | 只访问当前用户资源，缺失返回 404 |
| `POST /v1/archives` | 发布文章清单，返回 `{accepted,head,record}` |
| `POST /v1/usage` | 界面埋点：`{deviceId,platform,days:{"2026-09-19":{"articles.detail":3}}}` → `{accepted,ignored}`，见下文「界面埋点」 |

同步记录格式及合并规则共用 `src/sync/protocol.ts`。操作 ID 是幂等键，重复 ID 携带不同内容返回 `409 OPERATION_REUSED`，整批回滚。用户写入锁覆盖序号分配、当前状态、变更日志和操作回执的同一个事务。上传返回的 `head` **不能**直接覆盖下载游标。客户端只有完成本地落盘后才能推进下载游标。

快照分页水位固定，期间新增的变更不会进入旧快照。每用户最多保留 8 个未过期快照，24 小时过期；使用返回的 Token 恢复下载，避免每次重试新建快照。第一版保留全部增量日志、删除标记和幂等回执，不做历史压缩。

文章清单：

```json
{
  "articleId": "https://example.org/article",
  "version": "new-version-uuid",
  "title": "Article title",
  "url": "https://example.org/article",
  "htmlHash": "64-character-lowercase-sha256",
  "resources": [{ "hash": "64-character-lowercase-sha256", "mime": "image/png", "size": 12345 }],
  "missingResources": [],
  "createdTs": 1700000000000
}
```

清单可附加 `stamp`、`generation`、`opId` 对齐客户端同步操作。省略时服务端为该文章生成下一个逻辑版本。正文和全部已声明资源必须先上传；资源大小、版本不可变性在数据库事务内校验，文章版本和资源引用与同步日志同时提交。缺失资源列入 `missingResources`，不会伪装成完整备份。

资源上传在同一文件目录写临时文件、校验 SHA-256 并刷新磁盘，再原子替换正式文件，最后提交数据库元数据。用户资源配额由数据库用户锁保护；上传期间同一用户其他写操作等待。文件返回 `attachment`、`nosniff` 和禁止脚本的 CSP，客户端读取字节并在受控阅读器中展示。后端不执行原站脚本，也不接受任意文件路径或抓取 URL。

## 诊断

排查问题和分析性能走下面这些入口，不需要直接连数据库。界面上哪些按钮用得多、哪些没人用，看 `usage` 命令，见下文「界面埋点」。

**请求日志**：每个请求结束时向标准输出写一行 JSON，成功的 `/health` 探活不记。

```json
{"ts":"2026-09-19T08:22:19.927Z","method":"POST","route":"/v1/sync/push","status":200,"ms":20,"user":"<userId>","device":"<deviceId>","ops":4,"head":13,"in":1802,"out":180}
```

`route` 是路由模板（资源统一记作 `/v1/blobs/:hash`，未知路径记作 `unknown`），`in`/`out` 是请求和响应的 `Content-Length`，`error` 是返回给客户端的错误码；响应没发完连接就断了记 `status` 0、`error` 为 `ABORTED`。上传带 `device`、`ops`、`head`，下载和快照带 `records`、`cursor`、`hasMore`。日志不含请求头、请求体、Token、查询串和资源哈希。500 另外向标准错误输出方法、路由和异常堆栈。堆栈是异常消息加调用帧，数据库异常的消息可能引用出错的那个输入值；驱动附带的 `detail`、`where`（会引用整行）不输出。

**管理命令**，输出都是 JSON：

| 命令 | 内容 |
| --- | --- |
| `stats` | 数据库和各表体积、估算行数、死元组、顺序/索引扫描次数；每个用户的 `head`、各类型记录数（含删除标记）与字节数、变更日志按类型的条数与字节数、操作回执、快照、资源、设备最近活动、最大的 10 条记录、被改写次数最多的 10 条记录。只有数量、体积和标识符，没有记录内容 |
| `check [userId]` | 一致性自检，只读。`error`：存量记录过不了当前协议校验（`invalid-record`，客户端拉到会拒收）、行主键与记录内身份不符（`key-mismatch`）、变更日志不是连续的 `1..head`（`log-gap`）、记录与其序号处的日志条目不一致（`log-mismatch`）、序号超过 `head`（`sequence-ahead`）、文章记录指向没有清单的版本（`archive-version-missing`）、资源索引对应的文件缺失或大小不符（`blob-file-missing`）。`warning`：过期快照尚未清理（`expired-snapshots`）、磁盘上有未被索引的文件（`orphan-file`）、上传中断留下的临时文件（`upload-leftover`）。存在 `error` 时退出码为 1，可以放进定时任务；最多列出 1000 条，超出时 `truncated` 为 `true` |
| `show-record <userId> <type> <id>` | 唯一会输出记录内容的命令：当前合并结果、最近 50 条变更历史、最近 50 条各设备上传的原始操作 |
| `usage [userId]` | 各设备上传的首页按钮点击计数的汇总，按平台分开，零也列。字段见下文「界面埋点」 |

`check` 需要和服务进程相同的 `DATA_DIR`。容器里直接调用 `node`，避免 npm 在输出前面加横幅：

```sh
docker compose exec -T server node dist/server/src/admin.js stats
docker compose exec -T server node dist/server/src/admin.js check
docker compose logs --no-log-prefix --since 24h server | grep '^{' | jq -c 'select(.ms > 500 or .status >= 500)'
```

## 界面埋点

客户端记首页每个按钮每天被点了几次（只有次数，见根目录 README 的「界面埋点」），启用同步的设备每轮同步成功后顺带传上来，存在 `ui_usage` 表：一行是一台设备、一个本地日期、一个事件的累计数。它不是同步记录——不进 `records`、`changes`、`operations`，没有设备会把它拉回去。

- 客户端每天传的是**当天的累计数**而不是增量，服务器只在新数更大时覆盖。重发、重试、乱序到达都无害，所以这个接口不需要操作 ID 和回执。设备清空数据之后会换设备号，不会把以前的数拉低。
- `platform` 只能是 `extension` 或 `app`。事件名只校验形状（小写字母、数字、`.`、`-`，至多 64 个字符），不限于本版本认识的那张表：比服务器新的客户端会带来它没听过的事件，报表里归在 `unknown`。
- 一次至多 120 天、每天至多 200 个事件，次数是 1 到 10 亿的整数，结构不对返回 400。日期在「400 天前 ～ 后天」之外的那几天**丢掉并计入 `ignored`，不拒收**：成因多半是设备日期设错了，拒收只会让它把同一份东西永远重发下去。
- 上传会像 `push` 一样登记设备的 `last_seen_at`。请求日志里这一行带 `device` 和 `records`（收下的行数）。
- 不自动清理：一行几十字节，而「改版前后对比」正需要长一点的历史。用户删除时随账号一起删。

`usage [userId]` 输出 JSON：总的起止日期、用户数、设备数；`platforms` 里按平台各一份——`users`、`devices`、`deviceDays`（一台设备的一天算一个，读总数得先看它：40 次点击摊在 2 天里和摊在 60 天里不是一回事）、`events`（共用事件表里的**每一个**按钮一行，`last7` / `last30` / `total` / 用过它的 `users` 和 `devices`，次数多的在前，零也列）、`unused`（一次没人点过的事件名）、`unknown`（本版本不认识的事件名）。日期是各设备的本地日期，7 天和 30 天两个窗的远端边界有一天的模糊。

```sh
docker compose exec -T server node dist/server/src/admin.js usage | jq '.platforms[] | {platform, deviceDays, unused}'
```

事件表和客户端是同一份源文件（`src/lib/uiUsage.ts`，和 `src/sync/protocol.ts` 一样在构建镜像时拷进来），所以报表里的中文标签跟着服务器版本走。

## 备份与恢复

停止写入后备份数据库和 `DATA_DIR`，或使用经过验证的一致性备份方案。仅复制数据库不构成完整备份。第一版不自动回收资源，保留旧文章版本，避免误删离线设备需要的文件。事务失败或进程中止可能留下未引用的正式文件或 `.upload` 文件；不能按文件年龄盲删内容哈希文件。

恢复到旧备份时，在开放客户端连接前执行 `npm run admin -- rotate-server-id` 并重启所有服务实例。新的服务身份迫使设备重新确认连接，防止旧游标套用到恢复后的历史。设备下载游标超过当前水位时返回 `409 CURSOR_AHEAD`，不会静默忽略。新身份绑定后的本地数据合并需要用户明确选择；不能保证自动恢复备份之后尚未保留在任何设备的数据。

## 验证

```sh
npm run typecheck
npm test
npm run build
```

设置 `DATABASE_URL` 后，测试还会创建随机隔离 schema，在真实 PostgreSQL 验证迁移、凭证、多用户隔离、重复操作、事务回滚、并发序号、快照、删除合并、文件引用和配额，并只删除本次 schema。建议使用专门测试数据库。未配置连接时该集成套件明确显示为 skipped；GitHub Actions 提供 PostgreSQL 服务执行它。
