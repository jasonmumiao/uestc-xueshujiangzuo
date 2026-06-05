# 电子科技大学学术交流月讲座表

这是 `xueshujiangzuo.jasonmumiao.online` 的静态页面源码，用于整理电子科技大学研究生院 2026 年 6 月学术交流月讲座信息。

## 内容

- `index.html`：自包含静态页面，包含样式、数据和筛选逻辑。
- 数据源：电子科技大学研究生院“研究生学术交流月”栏目。
- 部署目标：Cloudflare Worker Custom Domain。

## 部署

当前线上 Worker 名称：

```bash
uestc-lectures-worker
```

部署命令：

```bash
npx wrangler deploy . --name uestc-lectures-worker --domain xueshujiangzuo.jasonmumiao.online --compatibility-date 2026-06-05
```
