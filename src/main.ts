import "./style.css";
import "cesium/Build/Cesium/Widgets/widgets.css";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { point } from "@turf/helpers";
import * as Cesium from "cesium";

type Position = [number, number];

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

const COUNTRY_URL =
  "https://raw.githubusercontent.com/datasets/geo-countries/master/data/countries.geojson";
const CHINA_PROVINCE_URL = "https://geo.datav.aliyun.com/areas_v3/bound/100000.json";

let provinceGeo: GeoCollection | null = null;
let cityDataSource: Cesium.CustomDataSource | null = null;
let clickedPointEntity: Cesium.Entity | null = null;

const toCartesian = ([lng, lat]: Position) => Cesium.Cartesian3.fromDegrees(lng, lat);

const setStatus = (text: string) => {
  if (statusEl) statusEl.textContent = `当前：${text}`;
};

const resolveGeoJson = async (geojson: string | object): Promise<GeoCollection> => {
  if (typeof geojson !== "string") return geojson as GeoCollection;
  const response = await fetch(geojson);
  return (await response.json()) as GeoCollection;
};

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
  if (feature.properties.center?.length === 2) return feature.properties.center;
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
  if (cityDataSource) {
    viewer.dataSources.remove(cityDataSource, true);
    cityDataSource = null;
  }

  const cityUrl = `https://geo.datav.aliyun.com/areas_v3/bound/${adcode}_full.json`;
  cityDataSource = await drawBoundaryLayer(cityUrl, Cesium.Color.fromCssColorString("#00e5ff"), 1.6);
};

const markClickedPoint = (position: Cesium.Cartesian3) => {
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
  try {
    await drawBoundaryLayer(COUNTRY_URL, Cesium.Color.fromCssColorString("#4dd0e1"), 1.1);
  } catch (error) {
    console.warn("country boundary load failed", error);
    setStatus("全球国界加载失败，已跳过");
  }
  await drawBoundaryLayer(CHINA_PROVINCE_URL, Cesium.Color.fromCssColorString("#ff7043"), 2.1);

  const response = await fetch(CHINA_PROVINCE_URL);
  provinceGeo = (await response.json()) as GeoCollection;

  const homeView = {
    destination: Cesium.Cartesian3.fromDegrees(104.0, 35.8, 23000000),
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
      // Snap to the exact agreed "home" camera to avoid tiny post-load drift.
      viewer.camera.setView(homeView);
    },
  });

  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction(async (movement: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
    const ray = viewer.camera.getPickRay(movement.position);
    if (!ray) return;
    const cartesian = viewer.scene.globe.pick(ray, viewer.scene);
    if (!cartesian) return;

    const cartographic = Cesium.Cartographic.fromCartesian(cartesian);
    const lng = Cesium.Math.toDegrees(cartographic.longitude);
    const lat = Cesium.Math.toDegrees(cartographic.latitude);

    const province = findProvinceByPoint(lng, lat);
    if (!province) return;

    markClickedPoint(cartesian);
    await loadCityBoundaries(province);

    const center = centerOfFeature(province) ?? [lng, lat];
    viewer.camera.flyTo({
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
