# koishi-plugin-xiaoheihe

一个面向 [Koishi](https://koishi.chat/) 的**只读**小黑盒 / Steam 资料插件。它可以读取小黑盒帖子正文、有限评论、帖子图片，以及游戏价格、评价和 Steam 公开资料，并可选接入 HDS Interlude 作为角色可浏览的外部信息来源。

> 非官方项目，与小黑盒、哔哩哔哩、Steam、Koishi 或 HDS 官方无隶属关系。接口可能随平台变化；请遵守平台规则并控制读取频率。

## 功能

- `xhh.feed [topicId]`：读取推荐流，或指定数字分区 ID 的候选帖子。
- `xhh.read <链接或帖子 ID>`：读取正文、有限评论样本，以及可选的图片描述。
- `xhh.game <名称或 AppID>`：读取小黑盒游戏字段；Steam 公开页面作为详情、国区价格和评价的补充/回退。
- `xhh.login` / `xhh.login.check`：使用小黑盒官方二维码登录；不会在聊天中显示 Cookie。
- `xhh.status`：查看登录、限额、缓存、图片理解和 HDS 桥状态。
- `xhh.clear yes`：清空本插件保存的外部资料原文和内存缓存，不删除 HDS 剧本。

推荐流中的条目只是标题和摘要，不代表已经读过正文。只有在实际读取成功后，插件才会提供正文、评论、图片描述或价格。

**没有任何发帖、评论、回复、点赞、关注、收藏或其他公开写入实现。**

## 环境要求

- Koishi `4.18+`
- Node.js `20+`
- HDS Interlude 为可选功能；共享观察桥当前针对 `1.0.1-rc57` 验证，升级 HDS 后可能需要重新适配。
- 图片理解可选复用 `atri-bili-eyes` 的视觉模型配置，本插件不重复保存 API Key。
- B 站共享读取为可选功能，需要兼容版本的 `atri-bili-eyes` 与 `atri-bilibili`。本仓库不包含这两个第三方插件。

## 安装

克隆并打包：

```bash
git clone https://github.com/AHHEY/koishi-plugin-xiaoheihe.git
cd koishi-plugin-xiaoheihe
npm pack
```

在 Koishi 实例目录安装生成的 tarball。以 Yarn 4 为例：

```bash
yarn add ./koishi-plugin-xiaoheihe-0.1.0.tgz
```

也可以使用 `npm install /absolute/path/to/koishi-plugin-xiaoheihe-0.1.0.tgz`。安装后重启 Koishi，并在插件配置中启用 `xiaoheihe`。

## 配置示例

```yaml
xiaoheihe:
  enabled: true
  ownerId: '允许使用命令的账号 ID'
  selfId: '机器人账号 ID'
  platform: onebot
  biliBridge: false
  gameCountry: cn
  gameLanguage: schinese
  gameReviews: true
  gameSearch: true
  imageUnderstanding: false
  imageMaxPerPost: 4
  imageDailyLimit: 10
  imageTimeoutMs: 15000
  dailyLimit: 40
  cacheMinutes: 30
  observationTtlHours: 24
```

`ownerId` 必须填写，否则不会开放聊天命令和扫码，避免其他人调用你的登录态。登录凭证保存在实例目录的 `data/xiaoheihe/account.json`，不会写进 YAML、日志或 HDS 剧本。

## 帖子图片理解

图片理解默认关闭。开启后，实际进入帖子正文时会下载最多 4 张公开图片，使用 `atri-bili-eyes` 中已配置的：

- `visionEndpoint`
- `visionApiKey`
- `visionModel`

生成逐张中文描述。图片描述只进入插件自己的临时观察表，并通过 HDS `webContext` 提供；不会写入长期剧本、事实、记忆或用户消息。刷候选列表不会触发图片识别。

限制：

- 每帖最多 4 张，每天最多 10 次视觉调用。
- 单张最多 4 MiB，单次合计最多 8 MiB，整体最多 90 秒。
- 只接受固定小黑盒 CDN 上的 JPEG、PNG、WebP。
- 拒绝重定向、非公网 DNS、伪造类型和超限响应。
- 图片请求不携带小黑盒或 B 站账号 Cookie。
- 视觉模型可能误判，图片内文字也可能包含提示注入。所有图片描述都按不可信外部资料处理。

启用前请先完整配置 `atri-bili-eyes` 的视觉模型。接口可能按调用量计费。

## 游戏价格和评价

`xhh.game` 会读取小黑盒游戏资料，并用 Steam 公开接口补充：

- 国区当前价格
- 原价、折后价和折扣百分比
- 价格读取时间
- Steam 总体评价等级
- 好评数、差评数和总评价数
- 开发商、发行商、发售日期、类型和简介
- 最多 12 条玩家评论样本

价格是读取时快照，不是历史最低价。评论是有限样本，不代表全部玩家。没有取得价格或评价时会明确标记不可用，不会编造。

## HDS 联动

插件实现 `communityObservations` 共享观察桥，只安装一次 HDS narrator / persistDecision 包装器，并处理：

- `xhh-feed:`
- `xhh-topic:`
- `xhh-post:`
- `xhh-comments:`
- `xhh-game:`

只有已经提交的 HDS 剧本产生的 deferred intent 才会执行读取。完整外部文本和图片描述保存在插件自己的 `xiaoheihe_observation` 表，按 TTL 过期清理；HDS 长期剧本只保存程序生成的短审计记录。

B 站共享读取还会处理 `bili:`、`bili-search:` 和视频链接。B 站插件可读取字幕、评论、弹幕；安装 `yt-dlp`、`ffmpeg`、`ffprobe` 后，`atri-bili-eyes` 还可以对短视频做有限帧抽样并生成画面描述。它没有音轨分析，也不代表完整播放。

## 安全边界

- 固定 HTTPS 域名、固定 API 路径和数字/受约束 ID。
- DNS 固定到公网地址，拒绝私网、保留地址、重定向和超大响应。
- 没有任何公开写入接口。
- Cookie、Token、二维码参数和视觉模型 Key 不进入模型上下文或普通日志。
- 外部帖子、评论、图片描述和网页资料全部作为不可信数据处理。
- 提示词隔离与 TTL 能阻止外部资料获得高权限归属和长期记忆，但无法从数学上消除模型级提示注入。

## 开发与测试

```bash
npm install
npm test
npm run check
```

当前自动测试覆盖协议解析、安全边界、图片下载、视觉请求隔离、缓存、限额、HDS intent 所有权、观察表隔离、生命周期和真实 Koishi 插件加载。

真实账号登录、真实图片识别和 Steam/B 站网络请求因地区、账号和平台风控而异；测试结果与尚未验证的项目见 [VALIDATION.md](VALIDATION.md)。

## 已知限制

- 小黑盒客户端接口不是公开稳定契约，可能变化。
- 图片理解不是完整看图或可靠 OCR。
- 帖子评论和 Steam 评论都是有限样本。
- 不查询全平台最低价，也不保证促销截止时间。
- HDS 共享桥依赖 rc57 的私有叙事方法。
- Windows 下凭据文件权限依赖实例目录 ACL。

## 许可

[MIT](LICENSE)。第三方参考和许可说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
