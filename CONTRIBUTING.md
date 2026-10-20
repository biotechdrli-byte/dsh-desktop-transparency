# 参与贡献

## 最有用的贡献：适配新的 DSH 版本

本插件最脆弱的地方是**分区选择器**——它们是 DSH 编译产物里的哈希类名
（`MnhYfG_` / `_727C8a_` / `THMRvG_`），DSH 一升级就可能全变。

如果你在升级 DSH 后发现某些分区滑块失效：

1. 打开面板，失效的分区名字后面会显示 **⚠**
2. 按 `Ctrl+Alt+D`，插件会把界面结构快照写到 `~/.dsh/dsh-dtp-dom.json`
3. 在快照里找到该区域的 `tag` / `class` / 尺寸（JSON 里节点字段：
   `t`=tag、`c`=class、`w`/`h`=尺寸、`p`=position、`d`=data-* 属性）
4. 修改 `lib/client.js` 顶部 `REGIONS` 数组里对应的 `sel`
5. 跑 `npm test`，提交 PR 时请附上 DSH 版本号

**优先使用 `data-*` 属性而不是哈希类名**——前者跨版本稳定得多。

## 开发

```sh
npm test        # 两套测试：客户端几何/分区、Host 路由
```

没有构建步骤：`lib/client.js` 手写成 ModuleLoader bundle，改完刷新即可。

调试技巧：

- `Ctrl+Alt+D` 导出结构快照
- 控制台看 `[dsh-desktop-transparency]` 开头的日志
- 面板底部的 `screen / win / view` 实时几何读数

## 提 PR 之前

- 跑通 `npm test`
- 改动选择器的话，在 `REGIONS` 上方注释里更新实测的 DSH 版本
- 新增可调参数请同步更新 `README.md` 的参数表与 `CHANGELOG.md`

## 报告问题

请附上：

- DSH Desktop 版本（设置里可见）与内核版本
- 面板截图（尤其是带 ⚠ 的）
- `~/.dsh/dsh-dtp-dom.json`（如果愿意，便于对齐结构）

## 许可

贡献即表示同意以 [MIT](LICENSE) 许可发布。
