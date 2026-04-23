# 家庭生活足迹 · 3D 记忆地球

基于 **Three.js + Vite + TypeScript** 的单页面 3D 互动应用。  
主页面展示可旋转缩放的地球，点击标记后进入地点记忆场景，查看照片与视频，并可返回地球继续浏览。

## 功能概览

- 3D 地球主视图（可拖拽旋转、滚轮缩放，移动端支持触摸）
- 地理坐标标记点（带地点名称与日期标签）
- 点击标记平滑过渡进入地点独立场景
- 地点场景中展示：
  - 图片（漂浮相框布局）
  - 视频（点击视频平面播放/暂停）
- 一键返回地球，保留离开前地球视角
- 数据集中在 `public/data/trips.json`
- 扩展效果：
  - 星空背景
  - 云层球体
  - 可选环境音（在 trips 数据中配置 `audio`）

## 本地运行

```bash
npm install
npm run dev
```

默认开发地址（Vite）：`http://localhost:5173`

如需构建生产版本：

```bash
npm run build
npm run preview
```

## 目录结构

```text
public/
  data/
    trips.json
  assets/
    images/
src/
  main.ts
  style.css
```

## 如何新增地点与媒体

1. **添加媒体文件**
   - 图片放到：`public/assets/images/`
   - 视频可放到：`public/assets/videos/`（需你自行创建该目录），也支持外部 URL

2. **编辑数据文件** `public/data/trips.json`
   - 在 `trips` 数组中新增一条对象，字段示例：

```json
{
  "id": 4,
  "name": "大理古城",
  "lat": 25.6065,
  "lng": 100.2676,
  "date": "2024-04-10",
  "images": [
    "assets/images/dali-1.jpg",
    "assets/images/dali-2.jpg"
  ],
  "videos": [
    "assets/videos/dali-trip.mp4"
  ],
  "description": "全家一起看洱海日落",
  "audio": "assets/audio/waves.mp3"
}
```

> 说明：  
> - `lat` / `lng` 使用十进制度（纬度/经度）  
> - `images` / `videos` 既可填本地相对路径，也可填完整 `https://...` URL  
> - `audio` 为可选字段，用于地点场景环境音

3. （可选）设置默认聚焦地点
   - 修改 `defaultTripId` 为对应地点 `id`

## 可定制点（便于二次修改）

- 标记样式：`src/main.ts` 中 `buildMarker`
- 地球、云层、光照：`src/main.ts` 中 `applyEarthTextures` 与场景初始化部分
- UI 配色和布局：`src/style.css`
- 场景过渡速度：`openTrip` / `returnToEarth` 中动画时长参数

