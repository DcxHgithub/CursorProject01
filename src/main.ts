import "./style.css";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";

type TripRecord = {
  id: number | string;
  name: string;
  lat: number;
  lng: number;
  date: string;
  images: string[];
  videos: string[];
  description: string;
  audio?: string;
};

type TripsPayload = {
  defaultTripId?: number | string;
  trips: TripRecord[];
};

type MarkerRuntime = {
  trip: TripRecord;
  mesh: THREE.Mesh;
  label: CSS2DObject;
  anchor: THREE.Vector3;
  pulseOffset: number;
};

const EARTH_RADIUS = 3;
const CAMERA_DISTANCE = 8.5;

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("#app container not found");

app.innerHTML = `
  <div id="scene-host"></div>
  <div id="overlay"></div>
  <header class="hud">
    <h1>家庭生活足迹 · 3D 记忆地球</h1>
    <p id="hud-subtitle">拖拽地球，点击标记进入每段回忆</p>
  </header>
  <button id="back-button" type="button" hidden>返回地球</button>
  <section id="memory-card" hidden>
    <h2 id="memory-title"></h2>
    <p id="memory-description"></p>
    <p id="memory-video-tip">点击场景中的视频画面可播放/暂停</p>
  </section>
`;

const sceneHost = document.querySelector<HTMLDivElement>("#scene-host");
const overlay = document.querySelector<HTMLDivElement>("#overlay");
const subtitle = document.querySelector<HTMLParagraphElement>("#hud-subtitle");
const backButton = document.querySelector<HTMLButtonElement>("#back-button");
const memoryCard = document.querySelector<HTMLElement>("#memory-card");
const memoryTitle = document.querySelector<HTMLHeadingElement>("#memory-title");
const memoryDescription = document.querySelector<HTMLParagraphElement>("#memory-description");
const memoryVideoTip = document.querySelector<HTMLParagraphElement>("#memory-video-tip");
if (
  !sceneHost ||
  !overlay ||
  !subtitle ||
  !backButton ||
  !memoryCard ||
  !memoryTitle ||
  !memoryDescription ||
  !memoryVideoTip
) {
  throw new Error("required UI element is missing");
}

const scene = new THREE.Scene();
scene.background = new THREE.Color("#03091a");

const camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.set(0, 0.8, CAMERA_DISTANCE);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;
sceneHost.append(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(window.innerWidth, window.innerHeight);
labelRenderer.domElement.style.position = "absolute";
labelRenderer.domElement.style.inset = "0";
labelRenderer.domElement.style.pointerEvents = "none";
sceneHost.append(labelRenderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 5;
controls.maxDistance = 13;
controls.minPolarAngle = 0.25;
controls.maxPolarAngle = Math.PI - 0.25;
controls.target.set(0, 0, 0);

scene.add(new THREE.AmbientLight(0x7b90ff, 0.58));
const sunLight = new THREE.DirectionalLight(0xffffff, 1.15);
sunLight.position.set(8, 4, 6);
scene.add(sunLight);

const earthRoot = new THREE.Group();
scene.add(earthRoot);

const memoryRoot = new THREE.Group();
memoryRoot.visible = false;
scene.add(memoryRoot);

const markerGroup = new THREE.Group();
earthRoot.add(markerGroup);

const earthMesh = new THREE.Mesh(
  new THREE.SphereGeometry(EARTH_RADIUS, 96, 96),
  new THREE.MeshStandardMaterial({
    color: "#5b97d6",
    roughness: 0.8,
    metalness: 0.05,
  })
);
earthRoot.add(earthMesh);

const cloudMesh = new THREE.Mesh(
  new THREE.SphereGeometry(EARTH_RADIUS + 0.045, 64, 64),
  new THREE.MeshStandardMaterial({
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
  })
);
earthRoot.add(cloudMesh);

const memoryMediaGroup = new THREE.Group();
memoryRoot.add(memoryMediaGroup);

const memoryShell = new THREE.Mesh(
  new THREE.SphereGeometry(22, 48, 48),
  new THREE.MeshStandardMaterial({
    color: "#17203d",
    side: THREE.BackSide,
    roughness: 1,
    metalness: 0,
  })
);
memoryRoot.add(memoryShell);

const memoryFloor = new THREE.Mesh(
  new THREE.CircleGeometry(5.6, 64),
  new THREE.MeshStandardMaterial({
    color: "#2f385d",
    roughness: 0.95,
    metalness: 0.02,
  })
);
memoryFloor.rotation.x = -Math.PI / 2;
memoryFloor.position.y = -0.1;
memoryRoot.add(memoryFloor);

const textureLoader = new THREE.TextureLoader();
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const textureCache = new Map<string, THREE.Texture>();
const markers: MarkerRuntime[] = [];
const floatingFrames: THREE.Mesh[] = [];

let trips: TripRecord[] = [];
let currentMode: "earth" | "memory" = "earth";
let transitionLocked = false;

let activeVideoElement: HTMLVideoElement | null = null;
let activeVideoTexture: THREE.VideoTexture | null = null;
let activeVideoMesh: THREE.Mesh | null = null;
let ambientAudio: HTMLAudioElement | null = null;

const savedEarthView = {
  cameraPosition: new THREE.Vector3(),
  cameraTarget: new THREE.Vector3(),
};

const loadTexture = (url: string) =>
  new Promise<THREE.Texture>((resolve, reject) => {
    textureLoader.load(
      url,
      (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        resolve(texture);
      },
      undefined,
      reject
    );
  });

const getCachedTexture = async (url: string) => {
  const cached = textureCache.get(url);
  if (cached) return cached;
  const texture = await loadTexture(url);
  textureCache.set(url, texture);
  return texture;
};

const createPlaceholderTexture = (label: string) => {
  const canvas = document.createElement("canvas");
  canvas.width = 768;
  canvas.height = 432;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    const fallback = new THREE.Texture();
    fallback.needsUpdate = true;
    return fallback;
  }

  const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  gradient.addColorStop(0, "#5e78b6");
  gradient.addColorStop(1, "#294478");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "rgba(0,0,0,0.26)";
  ctx.fillRect(34, 300, 420, 92);
  ctx.fillStyle = "#ecf2ff";
  ctx.font = "bold 36px sans-serif";
  ctx.fillText(label, 58, 356);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
};

const resolveMediaUrl = (source: string) => {
  if (/^https?:\/\//i.test(source)) return source;
  if (source.startsWith("/")) return source;
  return `/${source}`;
};

const latLngToVector = (lat: number, lng: number, radius: number) => {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lng + 180) * (Math.PI / 180);
  return new THREE.Vector3(
    -(radius * Math.sin(phi) * Math.cos(theta)),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta)
  );
};

const easeInOutCubic = (t: number) => {
  if (t < 0.5) return 4 * t * t * t;
  const progress = -2 * t + 2;
  return 1 - (progress * progress * progress) / 2;
};

const tween = (duration: number, onUpdate: (t: number) => void) =>
  new Promise<void>((resolve) => {
    const started = performance.now();
    const frame = (now: number) => {
      const raw = Math.min((now - started) / duration, 1);
      const eased = easeInOutCubic(raw);
      onUpdate(eased);
      if (raw < 1) {
        window.requestAnimationFrame(frame);
      } else {
        resolve();
      }
    };
    window.requestAnimationFrame(frame);
  });

const fadeOverlay = async (target: number, duration: number) => {
  const from = Number.parseFloat(overlay.style.opacity || "0");
  await tween(duration, (t) => {
    overlay.style.opacity = `${from + (target - from) * t}`;
  });
};

const animateCamera = async (nextPosition: THREE.Vector3, nextTarget: THREE.Vector3, duration: number) => {
  const startPosition = camera.position.clone();
  const startTarget = controls.target.clone();
  await tween(duration, (t) => {
    camera.position.lerpVectors(startPosition, nextPosition, t);
    controls.target.lerpVectors(startTarget, nextTarget, t);
    controls.update();
  });
};

const createStars = () => {
  const count = 1800;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    const radius = THREE.MathUtils.randFloat(25, 90);
    const theta = THREE.MathUtils.randFloat(0, Math.PI * 2);
    const phi = Math.acos(THREE.MathUtils.randFloatSpread(2));
    positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = radius * Math.cos(phi);
    positions[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const stars = new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      color: "#d6e8ff",
      size: 0.11,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.9,
    })
  );
  scene.add(stars);
};

const applyEarthTextures = async () => {
  const earthMaterial = earthMesh.material as THREE.MeshStandardMaterial;
  const cloudMaterial = cloudMesh.material as THREE.MeshStandardMaterial;
  try {
    const [earthMap, earthNormal, earthSpecular, cloudMap] = await Promise.all([
      loadTexture("https://threejs.org/examples/textures/planets/earth_atmos_2048.jpg"),
      loadTexture("https://threejs.org/examples/textures/planets/earth_normal_2048.jpg"),
      loadTexture("https://threejs.org/examples/textures/planets/earth_specular_2048.jpg"),
      loadTexture("https://threejs.org/examples/textures/planets/earth_clouds_1024.png"),
    ]);
    earthMaterial.map = earthMap;
    earthMaterial.normalMap = earthNormal;
    earthMaterial.metalnessMap = earthSpecular;
    earthMaterial.needsUpdate = true;
    cloudMaterial.map = cloudMap;
    cloudMaterial.needsUpdate = true;
  } catch (error) {
    console.warn("Failed to load earth textures, using fallback color.", error);
  }
};

const buildMarker = (trip: TripRecord) => {
  const markerMaterial = new THREE.MeshStandardMaterial({
    color: "#ffd67c",
    emissive: "#ff8f66",
    emissiveIntensity: 0.75,
    metalness: 0.25,
    roughness: 0.2,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.06, 18, 18), markerMaterial);
  const anchor = latLngToVector(trip.lat, trip.lng, EARTH_RADIUS + 0.06);
  mesh.position.copy(anchor);
  markerGroup.add(mesh);

  const labelElement = document.createElement("div");
  labelElement.className = "marker-label";
  labelElement.textContent = `${trip.name} · ${trip.date}`;
  const label = new CSS2DObject(labelElement);
  label.position.copy(anchor.clone().multiplyScalar(1.09));
  earthRoot.add(label);

  markers.push({
    trip,
    mesh,
    label,
    anchor,
    pulseOffset: Math.random() * Math.PI * 2,
  });
};

const setInitialView = (trip: TripRecord) => {
  const position = latLngToVector(trip.lat, trip.lng, CAMERA_DISTANCE);
  camera.position.copy(position);
  controls.target.set(0, 0, 0);
  controls.update();
};

const clearMemoryMedia = () => {
  floatingFrames.length = 0;
  for (const child of [...memoryMediaGroup.children]) {
    memoryMediaGroup.remove(child);
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose();
      if (Array.isArray(child.material)) {
        for (const material of child.material) material.dispose();
      } else {
        child.material.dispose();
      }
    }
  }
  if (activeVideoElement) {
    activeVideoElement.pause();
    activeVideoElement.src = "";
    activeVideoElement.load();
    activeVideoElement = null;
  }
  if (activeVideoTexture) {
    activeVideoTexture.dispose();
    activeVideoTexture = null;
  }
  activeVideoMesh = null;
  if (ambientAudio) {
    ambientAudio.pause();
    ambientAudio.src = "";
    ambientAudio.load();
    ambientAudio = null;
  }
};

const addImageFrames = (images: string[]) => {
  const safeLength = Math.max(images.length, 1);
  images.forEach((source, index) => {
    const frame = new THREE.Mesh(
      new THREE.PlaneGeometry(2.2, 1.3),
      new THREE.MeshStandardMaterial({
        color: "#eadfcd",
        emissive: "#271f18",
        emissiveIntensity: 0.2,
        side: THREE.DoubleSide,
      })
    );
    const spread = safeLength > 1 ? index / (safeLength - 1) : 0.5;
    const angle = (spread - 0.5) * Math.PI * 0.92;
    const radius = 3.4;
    const y = 1.5 + (index % 2 === 0 ? 0.18 : -0.08);
    frame.position.set(Math.sin(angle) * radius, y, -Math.cos(angle) * radius);
    frame.lookAt(new THREE.Vector3(0, 1.4, 0));
    frame.userData.baseY = y;
    memoryMediaGroup.add(frame);
    floatingFrames.push(frame);

    const url = resolveMediaUrl(source);
    void getCachedTexture(url)
      .then((texture) => {
        const material = frame.material as THREE.MeshStandardMaterial;
        material.map = texture;
        material.needsUpdate = true;
      })
      .catch((error) => {
        console.warn(`Failed to load image: ${url}`, error);
        const material = frame.material as THREE.MeshStandardMaterial;
        material.map = createPlaceholderTexture("媒体加载失败");
        material.needsUpdate = true;
      });
  });
};

const addVideoScreen = (videos: string[]) => {
  if (videos.length === 0) return;
  const url = resolveMediaUrl(videos[0]);
  const video = document.createElement("video");
  video.src = url;
  video.loop = true;
  video.playsInline = true;
  video.preload = "metadata";
  video.crossOrigin = "anonymous";
  video.muted = false;
  video.addEventListener("error", () => {
    subtitle.textContent = "视频加载失败，可在 data/trips.json 中替换为可访问地址。";
  });

  const videoTexture = new THREE.VideoTexture(video);
  videoTexture.colorSpace = THREE.SRGBColorSpace;

  const videoPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(3.2, 1.8),
    new THREE.MeshBasicMaterial({
      map: videoTexture,
      side: THREE.DoubleSide,
      toneMapped: false,
    })
  );
  videoPlane.position.set(0, 1.5, -3.85);
  videoPlane.lookAt(new THREE.Vector3(0, 1.5, 0));
  memoryMediaGroup.add(videoPlane);

  activeVideoElement = video;
  activeVideoTexture = videoTexture;
  activeVideoMesh = videoPlane;
};

const playAmbientAudio = (source?: string) => {
  if (!source) return;
  const audio = new Audio(resolveMediaUrl(source));
  audio.loop = true;
  audio.volume = 0.35;
  void audio.play().catch(() => {
    // 用户手势限制时，下一次点击场景可再次触发播放。
  });
  ambientAudio = audio;
};

const enterMemoryMode = (trip: TripRecord) => {
  currentMode = "memory";
  controls.enabled = false;
  earthRoot.visible = false;
  labelRenderer.domElement.style.display = "none";

  memoryRoot.visible = true;
  backButton.hidden = false;
  memoryCard.hidden = false;
  memoryTitle.textContent = `${trip.name} · ${trip.date}`;
  memoryDescription.textContent = trip.description;
  memoryVideoTip.hidden = trip.videos.length === 0;

  clearMemoryMedia();
  addImageFrames(trip.images);
  addVideoScreen(trip.videos);
  playAmbientAudio(trip.audio);

  camera.position.set(0, 1.55, 6.1);
  controls.target.set(0, 1.45, 0);
  camera.lookAt(controls.target);
  subtitle.textContent = "点击视频画面可播放，点“返回地球”继续浏览其他足迹";
};

const returnToEarth = async () => {
  if (transitionLocked || currentMode !== "memory") return;
  transitionLocked = true;
  await fadeOverlay(1, 380);

  clearMemoryMedia();
  memoryRoot.visible = false;
  backButton.hidden = true;
  memoryCard.hidden = true;

  earthRoot.visible = true;
  labelRenderer.domElement.style.display = "block";
  currentMode = "earth";
  controls.enabled = true;
  camera.position.copy(savedEarthView.cameraPosition);
  controls.target.copy(savedEarthView.cameraTarget);
  controls.update();
  subtitle.textContent = "拖拽地球，点击标记进入每段回忆";

  await fadeOverlay(0, 380);
  transitionLocked = false;
};

const openTrip = async (marker: MarkerRuntime) => {
  if (transitionLocked || currentMode !== "earth") return;
  transitionLocked = true;
  savedEarthView.cameraPosition.copy(camera.position);
  savedEarthView.cameraTarget.copy(controls.target);

  const target = marker.anchor.clone();
  const destination = target.clone().multiplyScalar(1.95);
  await animateCamera(destination, target, 850);
  await fadeOverlay(1, 430);
  enterMemoryMode(marker.trip);
  await fadeOverlay(0, 430);
  transitionLocked = false;
};

const onCanvasPointerDown = (event: PointerEvent) => {
  if (transitionLocked) return;
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);

  if (currentMode === "earth") {
    const hit = raycaster.intersectObjects(
      markers.map((marker) => marker.mesh),
      false
    );
    if (!hit[0]) return;
    const marker = markers.find((item) => item.mesh === hit[0].object);
    if (marker) void openTrip(marker);
    return;
  }

  if (currentMode === "memory" && activeVideoMesh && activeVideoElement) {
    const hit = raycaster.intersectObject(activeVideoMesh, false);
    if (!hit[0]) return;
    if (activeVideoElement.paused) {
      void activeVideoElement.play().catch((error) => {
        console.warn("video play failed", error);
      });
    } else {
      activeVideoElement.pause();
    }
  }
};

const onResize = () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  labelRenderer.setSize(window.innerWidth, window.innerHeight);
};

const loadTrips = async () => {
  const response = await fetch("/data/trips.json");
  if (!response.ok) {
    throw new Error(`Failed to load trips data: ${response.status}`);
  }
  const payload = (await response.json()) as TripsPayload;
  trips = payload.trips;
  if (!Array.isArray(trips) || trips.length === 0) {
    throw new Error("Trips data is empty.");
  }

  for (const trip of trips) {
    buildMarker(trip);
  }

  const defaultTrip = trips.find((trip) => trip.id === payload.defaultTripId) ?? trips[0];
  setInitialView(defaultTrip);
};

const animate = (time: number) => {
  controls.update();
  earthMesh.rotation.y += 0.00035;
  cloudMesh.rotation.y += 0.0005;

  for (const marker of markers) {
    const pulse = 1 + Math.sin(time * 0.004 + marker.pulseOffset) * 0.24;
    marker.mesh.scale.setScalar(pulse);
  }

  if (currentMode === "memory") {
    floatingFrames.forEach((frame, index) => {
      const baseY = Number(frame.userData.baseY ?? frame.position.y);
      frame.position.y = baseY + Math.sin(time * 0.0012 + index) * 0.09;
      frame.rotation.y = Math.sin(time * 0.001 + index * 0.6) * 0.08;
    });
  }

  renderer.render(scene, camera);
  if (labelRenderer.domElement.style.display !== "none") {
    labelRenderer.render(scene, camera);
  }
  window.requestAnimationFrame(animate);
};

const boot = async () => {
  createStars();
  await applyEarthTextures();
  await loadTrips();
  renderer.domElement.addEventListener("pointerdown", onCanvasPointerDown);
  window.addEventListener("resize", onResize);
  backButton.addEventListener("click", () => {
    void returnToEarth();
  });
  animate(performance.now());
};

void boot().catch((error) => {
  console.error(error);
  subtitle.textContent = "数据或资源加载失败，请检查控制台和 data/trips.json。";
});
