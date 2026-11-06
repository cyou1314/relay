# Relay Mac 真机部署清单（DEPLOY-MAC）

执行者：在主人 Mac 上干活的 Codex。照步骤编号顺序执行，**每一步先跑验证命令、对照预期输出，确认无误才进下一步**。任何一步输出与预期不符：**立即停手**，把该步的命令与完整报错原样回报主人，不许自行猜测修复、不许跳步。

## 红线（全程有效）

1. **不许改动 `~/.codex` 里 Relay 托管段之外的任何内容**。对 `~/.codex` 的唯一合法写入是第 5 步的 config-manager install（它自带版本门与逐字节备份）。
2. **不许打印 `~/.codex/auth.json`、`~/.gemini/oauth_creds.json` 或任何 token 的内容**：连 `cat`、`head`、`echo $TOKEN` 都不行；只能用 `ls -l` 确认文件存在。
3. 不许把任何 key/token 写进任何文件、命令历史或回报文字。
4. 网关只许监听 127.0.0.1（这是网关自身行为，不需要你额外配置，也不要改）。
5. 出错立即停手，原样回报错误（命令 + 完整输出），等主人裁决。

## 变量约定（后文直接引用）

- Relay 目录：`~/relay`
- node 路径：`/Users/cyou/node/bin/node`（第 1 步会验它存在；不在就停手回报）
- 网关地址：`http://127.0.0.1:18923`

---

## 第 0 步：确认 node 与 Codex 可用

```bash
ls -l /Users/cyou/node/bin/node
/Users/cyou/node/bin/node --version
codex --version
```

预期：node 文件存在且版本 ≥ 18；`codex --version` 能打出版本号且 ≥ 0.100.0（config-manager 的版本门要求，低于它第 5 步会被拒绝——先在这里就停手回报，不要走到第 5 步才发现）。

## 第 1 步：把仓库放到 ~/relay

已存在则更新，不存在则克隆（公开仓库，无需登录）：

```bash
if [ -d ~/relay/.git ]; then cd ~/relay && git pull --ff-only; else git clone https://github.com/cyou1314/relay.git ~/relay; fi
cd ~/relay && git log --oneline -1
```

预期：pull/clone 无报错；最后一行打出最新提交。网络失败或仓库不存在 → 停手回报原文。

## 第 2 步：跑全量测试（部署闸门）

```bash
cd ~/relay && /Users/cyou/node/bin/node --version && npm test 2>&1 | tail -5
```

预期：最后一行是 `RESULT: 297 passed, 0 failed`（提交变化时总数可不同，但必须 `0 failed`）。有任何 FAIL → 停手回报失败行，不许带病部署。

## 第 3 步：安装生产配置与 launchd

生产配置已在仓库里（`deploy/relay.config.json`，第 1 步已随仓库到位），确认它在：

```bash
ls -l ~/relay/deploy/relay.config.json && /Users/cyou/node/bin/node -e "JSON.parse(require('fs').readFileSync(process.env.HOME+'/relay/deploy/relay.config.json','utf8')); console.log('config json ok')"
```

预期：文件存在，输出 `config json ok`。

由模板生成正式 plist（替换三个占位符）并装到 LaunchAgents：

```bash
mkdir -p ~/Library/LaunchAgents ~/Library/Logs
sed -e "s|__RELAY_DIR__|$HOME/relay|g" -e "s|__NODE_BIN__|/Users/cyou/node/bin/node|g" -e "s|__HOME__|$HOME|g" \
  ~/relay/deploy/com.muse.relay.plist > ~/Library/LaunchAgents/com.muse.relay.plist
plutil -lint ~/Library/LaunchAgents/com.muse.relay.plist
grep -c "__" ~/Library/LaunchAgents/com.muse.relay.plist
```

预期：`plutil -lint` 输出 `OK`；`grep -c "__"` 输出 `0`（占位符全部替换干净；若不为 0，停手回报，不要 load）。

## 第 4 步：启动网关并验收端点

```bash
launchctl unload ~/Library/LaunchAgents/com.muse.relay.plist 2>/dev/null; launchctl load ~/Library/LaunchAgents/com.muse.relay.plist
sleep 2
launchctl list | grep com.muse.relay
curl -s -o /dev/null -w "status:%{http_code}\n" http://127.0.0.1:18923/api/status
curl -s -o /dev/null -w "dashboard:%{http_code}\n" http://127.0.0.1:18923/dashboard
```

预期：`launchctl list` 有一行 `com.muse.relay` 且第二列（退出码）为 `0`；两个 curl 都打 `200`。起不来或非 200 → 停手，把 `tail -50 ~/Library/Logs/relay-gateway.log` 的内容原样回报。

## 第 5 步：把 provider 写进真 ~/.codex（唯一的配置写入）

先看现状（只读，不改任何东西）：

```bash
cd ~/relay && /Users/cyou/node/bin/node src/config-manager.js status --codex-home ~/.codex
```

预期输出（一行 JSON）：`"managed":false,"backupExists":false`（首次部署）。若 `"managed":true` 已存在，说明此前装过——停手回报，不要重复 install。

执行 install：

```bash
cd ~/relay && /Users/cyou/node/bin/node src/config-manager.js install --codex-home ~/.codex
```

预期输出（一行 JSON）：`"ok":true,"action":"install"`，含 `"baseUrl":"http://127.0.0.1:18923/v1"`。它被拒绝（版本门/冲突）时退出码非 0 且打一行说明 → 原样回报，不要手工改 config.toml 绕过。

install 后立即核三件事：

```bash
ls -l ~/.codex/config-before-relay.toml
cd ~/relay && /Users/cyou/node/bin/node src/config-manager.js status --codex-home ~/.codex
diff <(cat ~/.codex/config-before-relay.toml) <(cat ~/.codex/config.toml) | head -40
```

预期：备份文件存在（install 前的原配置逐字节备份，还原靠它）；status 打 `"managed":true,"provider":"relay"`；diff 只出现 Relay 托管段的增减（文件首的 `model_provider = "relay"` 选择行 + 文件尾的 `[model_providers.relay]` 表，两段都有 `# BEGIN/END RELAY MANAGED` 标记）——**托管段之外有任何一行差异，立即停手回报 diff 原文**。

## 第 6 步：真链验证（经 Relay 跑一次真 Codex）

```bash
cd /tmp && codex exec "执行 shell 命令：echo relay-mac-ok > /tmp/relay-proof.txt，然后 cat /tmp/relay-proof.txt，把输出原样告诉我" </dev/null
cat /tmp/relay-proof.txt
tail -3 ~/relay/logs/routing.jsonl
```

预期：codex exec 正常退出、回复与 `cat` 都给出 `relay-mac-ok`；`routing.jsonl` 末尾新增了本次请求的记录（`path` 为 `/v1/responses`、上游是 `codex-plan`、状态 200）。真链不通（报错、超时、无新日志行）→ 停手原样回报。

## 第 7 步：仪表盘验收

在浏览器打开 `http://127.0.0.1:18923/dashboard`，逐项对照：

- Codex 卡显示真实双窗数字，小字形如「5 小时内还剩 X%，这周还剩 Y%」，且**没有**「估算」标签（数字可与 Codex 客户端自己的用量显示交叉核对一次）
- Gemini 卡带「估算」标签（凭证还没接，这是预期的）
- 「最近动态」里有第 6 步刚产生的真请求记录，原因是一句人话
- 页面是白灰 + 磨砂玻璃四块结构，没有报错、没有空白块

任一项不对 → 截图或原样描述回报，不要自行改代码。

## 第 8 步：Gemini 凭证（占位，本清单不执行登录）

**等待主人本人在场完成一次 Google 登录授权**，生成凭证文件后，只需确认网关能找到它并重启：

```bash
# 主人完成登录后才跑这一段；默认路径存在即可，路径不同再用 RELAY_GEMINI_CREDS 指过去
ls -l ~/.gemini/oauth_creds.json
launchctl kickstart -k gui/$(id -u)/com.muse.relay
curl -s http://127.0.0.1:18923/api/status | /Users/cyou/node/bin/node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{console.log(JSON.stringify(JSON.parse(d).quota||JSON.parse(d),null,2))})"
```

在那之前 Gemini 上游会因凭证缺失被自动绕开（路由走 Codex），属正常状态，不算部署失败。**本清单到此为止：不代主人登录、不索取任何验证码或密码。**

---

## 收尾回报格式（给主人）

逐步报「第 N 步：通过 / 停在第 N 步：<命令> + <完整报错原文>」。全部通过时附三样：第 5 步 status 的 JSON 行、第 6 步的 `relay-mac-ok` 输出、第 7 步仪表盘四项对照结果。

## 回滚（主人说撤才执行，平时不用）

```bash
cd ~/relay && /Users/cyou/node/bin/node src/config-manager.js restore --codex-home ~/.codex
launchctl unload ~/Library/LaunchAgents/com.muse.relay.plist
```

restore 用第 5 步的备份逐字节还原 `config.toml` 并删备份；执行后用 status 应回到 `"managed":false`。
