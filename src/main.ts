import "./style.css";
import "cesium/Build/Cesium/Widgets/widgets.css";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { point } from "@turf/helpers";
import * as Cesium from "cesium";

// 经纬度坐标，单位是角度：[经度, 纬度]。
type Position = [number, number];

// 本页面用到的最小 GeoJSON Feature 结构。
type GeoFeature = {
  type: string;
  properties: {
    name?: string;
    adcode?: number | string;
    center?: Position;
  };
  geometry: {
    type: "Polygon" | "MultiPolygon";
    coordinates: number[][][] | number[][][][];
  };
};

type GeoCollection = {
  type: "FeatureCollection";
  features: GeoFeature[];
};

// 直接在代码中拼页面结构，保持示例自包含。
const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("#app not found");

app.innerHTML = `
  <div id="viewer"></div>
  <aside class="panel">
    <h1>个人简介 · 三维地球</h1>
    <p>初始为中国视角，显示全球国界与中国省界。</p>
    <p>点击中国境内任意省份区域，镜头自动切换到该省，并加载该省市界。</p>
    <p id="status">当前：全国视角（中国）</p>
  </aside>
`;

const statusEl = document.querySelector<HTMLParagraphElement>("#status");

// Cesium 场景初始化：
// - 精简控件，突出地球主视图
// - 使用卫星底图
// - 关闭地形，避免大规模行政区几何在某些情况下触发渲染边界问题
const viewer = new Cesium.Viewer("viewer", {
  animation: false,
  timeline: false,
  baseLayerPicker: false,
  geocoder: false,
  homeButton: false,
  infoBox: false,
  navigationHelpButton: false,
  sceneModePicker: false,
  fullscreenButton: false,
  selectionIndicator: false,
  terrain: undefined,
  baseLayer: Cesium.ImageryLayer.fromProviderAsync(
    Cesium.ArcGisMapServerImageryProvider.fromUrl(
      "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer"
    )
  ),
});

viewer.scene.globe.depthTestAgainstTerrain = false;
viewer.scene.screenSpaceCameraController.minimumZoomDistance = 700000;

// 全球国界（GeoJSON）+ 中国省界（带 adcode 的 GeoJSON 服务）。
const COUNTRY_URL =
  "https://raw.githubusercontent.com/datasets/geo-countries/master/data/countries.geojson";
const CHINA_PROVINCE_URL = "https://geo.datav.aliyun.com/areas_v3/bound/100000.json";

// 运行时状态：
// - provinceGeo：用于点中省份判定的原始省级 GeoJSON
// - cityDataSource：当前选中省份对应的市界图层
// - clickedPointEntity：最近一次点击的地表标记点
let provinceGeo: GeoCollection | null = null;
let cityDataSource: Cesium.CustomDataSource | null = null;
let clickedPointEntity: Cesium.Entity | null = null;

const toCartesian = ([lng, lat]: Position) => Cesium.Cartesian3.fromDegrees(lng, lat);

const setStatus = (text: string) => {
  if (statusEl) statusEl.textContent = `当前：${text}`;
};

// 同时支持 URL 字符串和已加载对象，
// 让 drawBoundaryLayer 可复用在静态与动态数据源上。
const resolveGeoJson = async (geojson: string | object): Promise<GeoCollection> => {
  if (typeof geojson !== "string") return geojson as GeoCollection;
  const response = await fetch(geojson);
  return (await response.json()) as GeoCollection;
};

// 统一几何结构：
// Polygon -> [ring, ...]
// MultiPolygon -> 扁平化为 [ring, ...]
// 当前仅需 ring 坐标来绘制边界线。
const getRings = (feature: GeoFeature): number[][][] => {
  if (feature.geometry.type === "Polygon") {
    return feature.geometry.coordinates as number[][][];
  }
  const multi = feature.geometry.coordinates as number[][][][];
  return multi.flatMap((polygon) => polygon);
};

const drawBoundaryLayer = async (
  geojson: string | object,
  stroke: Cesium.Color,
  strokeWidth: number
) => {
  // 用 polyline 渲染边界，而不是面几何。
  // 这样可以规避复杂行政区多边形在 Cesium worker 中偶发崩溃的问题。
  const collection = await resolveGeoJson(geojson);
  const ds = new Cesium.CustomDataSource("boundary-lines");

  for (const feature of collection.features) {
    const rings = getRings(feature);
    for (const ring of rings) {
      if (!ring || ring.length < 2) continue;
      const degreesArray: number[] = [];
      for (const coordinate of ring) {
        if (coordinate.length < 2) continue;
        degreesArray.push(coordinate[0], coordinate[1]);
      }
      if (degreesArray.length < 4) continue;
      ds.entities.add({
        polyline: {
          // Cesium 的 fromDegreesArray 需要 [经1, 纬1, 经2, 纬2, ...]。
          positions: Cesium.Cartesian3.fromDegreesArray(degreesArray),
          width: strokeWidth,
          material: stroke,
          clampToGround: false,
        },
      });
    }
  }

  viewer.dataSources.add(ds);
  return ds;
};

const centerOfFeature = (feature: GeoFeature): Position | null => {
  // 优先使用数据源提供的官方中心点。
  if (feature.properties.center?.length === 2) return feature.properties.center;
  // 兜底方案：从首个 ring 取中间点。
  // 这不是严格几何质心，但足够用作镜头飞行目标锚点。
  if (feature.geometry.type === "Polygon") {
    const polygonCoordinates = feature.geometry.coordinates as number[][][];
    const ring = polygonCoordinates[0];
    if (!ring?.length) return null;
    const [lng, lat] = ring[Math.floor(ring.length / 2)];
    return [lng, lat];
  }
  const multiCoordinates = feature.geometry.coordinates as number[][][][];
  const firstPolygon = multiCoordinates[0]?.[0];
  if (!firstPolygon?.length) return null;
  const [lng, lat] = firstPolygon[Math.floor(firstPolygon.length / 2)];
  return [lng, lat];
};

const findProvinceByPoint = (lng: number, lat: number): GeoFeature | null => {
  if (!provinceGeo) return null;
  const clicked = point([lng, lat]);
  // 遍历省份，返回第一个包含点击点的省级要素。
  for (const feature of provinceGeo.features) {
    if (booleanPointInPolygon(clicked, feature as never)) {
      return feature;
    }
  }
  return null;
};

const loadCityBoundaries = async (province: GeoFeature) => {
  const adcode = province.properties.adcode;
  if (!adcode) return;
  // 只保留一个市界图层，避免重复叠加和旧数据残留。
  if (cityDataSource) {
    viewer.dataSources.remove(cityDataSource, true);
    cityDataSource = null;
  }

  const cityUrl = `https://geo.datav.aliyun.com/areas_v3/bound/${adcode}_full.json`;
  cityDataSource = await drawBoundaryLayer(cityUrl, Cesium.Color.fromCssColorString("#00e5ff"), 1.6);
};

const markClickedPoint = (position: Cesium.Cartesian3) => {
  // 替换旧标记，保证页面只展示“最近一次点击”的位置。
  if (clickedPointEntity) {
    viewer.entities.remove(clickedPointEntity);
  }
  clickedPointEntity = viewer.entities.add({
    position,
    point: {
      pixelSize: 10,
      color: Cesium.Color.YELLOW,
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 2,
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
    },
  });
};

const boot = async () => {
  // 全球国界属于增强信息：即使加载失败，也不影响主流程继续运行。
  try {
    await drawBoundaryLayer(COUNTRY_URL, Cesium.Color.fromCssColorString("#4dd0e1"), 1.1);
  } catch (error) {
    console.warn("country boundary load failed", error);
    setStatus("全球国界加载失败，已跳过");
  }
  await drawBoundaryLayer(CHINA_PROVINCE_URL, Cesium.Color.fromCssColorString("#ff7043"), 2.1);

  // 再取一份省界原始数据，用于后续点选命中判定。
  const response = await fetch(CHINA_PROVINCE_URL);
  provinceGeo = (await response.json()) as GeoCollection;

  // 首页视角目标：
  // - 首屏完整看到地球
  // - 球心与页面中心对齐
  // - 朝向中国区域
  const homeView = {
    destination: Cesium.Cartesian3.fromDegrees(104.0, 20.0, 21000000),
    orientation: {
      heading: 0,
      pitch: Cesium.Math.toRadians(-90),
      roll: 0,
    },
  };
  viewer.camera.flyTo({
    destination: homeView.destination,
    orientation: homeView.orientation,
    duration: 2.2,
    complete: () => {
      // 飞行动画结束后再 setView 一次，避免极小的姿态漂移。
      viewer.camera.setView(homeView);
    },
  });

  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction(async (movement: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
    // 把屏幕点击点转换为地表坐标：屏幕点 -> 射线 -> 地球表面 Cartesian。
    const ray = viewer.camera.getPickRay(movement.position);
    if (!ray) return;
    const cartesian = viewer.scene.globe.pick(ray, viewer.scene);
    if (!cartesian) return;

    const cartographic = Cesium.Cartographic.fromCartesian(cartesian);
    const lng = Cesium.Math.toDegrees(cartographic.longitude);
    const lat = Cesium.Math.toDegrees(cartographic.latitude);

    const province = findProvinceByPoint(lng, lat);
    if (!province) return;

    // 命中省份后的流程：
    // 1) 标记点击点
    // 2) 加载该省市界
    // 3) 镜头飞到该省区域
    // 4) 更新状态文案
    markClickedPoint(cartesian);
    await loadCityBoundaries(province);

    const center = centerOfFeature(province) ?? [lng, lat];
    viewer.camera.flyTo({
      // 略微抬高纬度，配合俯仰角时视觉中心更自然。
      destination: toCartesian([center[0], center[1] + 0.15]).clone(),
      duration: 1.8,
      orientation: {
        heading: 0,
        pitch: Cesium.Math.toRadians(-55),
        roll: 0,
      },
    });

    setStatus(`${province.properties.name ?? "未知省份"}（已加载市界）`);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
};

boot().catch((error: unknown) => {
  setStatus("数据加载失败，请检查网络连接");
  console.error(error);
});
