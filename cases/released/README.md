# Released cases · 已发布的案件

Case files in this folder are served by the deployed game, beside the handwritten case in
`src/case/fixtures/`. A file is listed only if it passes the gate when the server starts:
well formed, consistent, and provable by a player.

这个目录里的案件文件会由部署后的游戏提供，与 `src/case/fixtures/` 里的手写案件并列。
服务器启动时只列出通过检查的文件：格式正确、内容一致、玩家能够证明。

A case file holds its own answer. Only put a case here once it is meant to be public.

`lighthouse.json` is the handwritten 20-person plot (`src/writer/fixtures/lighthouse.ts`), put
together by the case writer's own code. `npm run release:lighthouse` writes it, and a test
fails while the file and the plot differ. Its answer was public already: the replay that
ships with the page plays it to the end.

案件文件包含它自己的答案。只有决定公开的案件才放在这里。

`lighthouse.json` 是手写的 20 人灯塔案（`src/writer/fixtures/lighthouse.ts`），由案件写作代码
自己拼装而成。`npm run release:lighthouse` 会写出它；文件与情节不一致时，有一项测试会失败。
它的答案本来就是公开的：页面自带的回放会把它一直放到结局。
