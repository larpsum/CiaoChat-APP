import * as THREE from "./vendor/three.module.js";
import { GLTFLoader } from "./vendor/loaders/GLTFLoader.js";
import { RGBELoader } from "./vendor/loaders/RGBELoader.js";
import { EffectComposer } from "./vendor/postprocessing/EffectComposer.js";
import { RenderPass } from "./vendor/postprocessing/RenderPass.js";

(() => {
  const shell = document.getElementById("authShell");
  const sceneCanvas = document.getElementById("loginScene");
  const fieldCanvas = document.getElementById("asciiField");
  const glassCanvas = document.getElementById("glassPane");
  const sceneTelemetry = document.getElementById("sceneTelemetry");
  const fieldStatus = document.getElementById("fieldStatus");
  const bgVideo = document.getElementById("bgVideo");
  const useVideoBg = !!bgVideo;
  if (useVideoBg) shell.classList.add("has-bg-video");
  if (!shell || !sceneCanvas || !fieldCanvas || !glassCanvas) return;

  const field = fieldCanvas.getContext("2d");
  const glass = glassCanvas.getContext("2d");
  if (!field) {
    console.error("[login-scene] Could not initialize the ASCII field canvas.");
    return;
  }
  if (!glass) {
    console.error("[login-scene] Could not initialize the glass canvas.");
    return;
  }

  const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  let width = 0;
  let height = 0;
  let pixelRatio = 1;
  let pointer = null;
  let pointerOnPanel = false;
  let parallaxTarget = { x: 0, y: 0 };
  let parallax = { x: 0, y: 0 };
  let pointerMovedAt = 0;
  let scanTriggered = false;
  let scans = [];
  let nextAutoScan = 0;
  let frame = 0;
  let running = false;
  let resizeObserver = null;
  let lastGlassDraw = 0;
  let assetsReady = false;

  const random = (min, max) => min + Math.random() * (max - min);
  const randomInt = max => Math.floor(Math.random() * max);
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  const ASSET_BASE = "/static/assets/field-survey/";

  function setSceneTelemetry(text) {
    if (sceneTelemetry && sceneTelemetry.textContent !== text) sceneTelemetry.textContent = text;
    if (fieldStatus && fieldStatus.textContent !== text) fieldStatus.textContent = text;
  }

  function fadeScans(now, exceptPoint = null) {
    for (const scan of scans) {
      if (exceptPoint && Math.hypot(scan.x - exceptPoint.x, scan.y - exceptPoint.y) < 112) continue;
      scan.fadeAt ??= now;
    }
  }

  function drawGlass(now, delta, force = false) {
    if (!force && now - lastGlassDraw < 24) return;
    lastGlassDraw = now;
    glass.clearRect(0, 0, width, height);
    const sheen = glass.createLinearGradient(0, 0, width, height);
    sheen.addColorStop(0, "rgba(236, 248, 239, 0.038)");
    sheen.addColorStop(0.46, "rgba(236, 248, 239, 0.008)");
    sheen.addColorStop(1, "rgba(190, 225, 203, 0.028)");
    glass.fillStyle = sheen;
    glass.fillRect(0, 0, width, height);

    glass.save();
    glass.lineCap = "round";
    for (let streak = 0; streak < 26; streak++) {
      const x = ((streak * 0.61803398875) % 1) * width;
      const y = ((streak * 0.38196601125) % 1) * height;
      const length = 18 + (streak % 6) * 11;
      glass.strokeStyle = `rgba(230, 246, 235, ${0.018 + (streak % 4) * 0.008})`;
      glass.lineWidth = 0.45 + (streak % 3) * 0.25;
      glass.beginPath();
      glass.moveTo(x, y);
      glass.bezierCurveTo(x + 2, y + length * 0.34, x - 1.5, y + length * 0.68, x + Math.sin(streak) * 1.5, y + length);
      glass.stroke();
    }
    glass.restore();

    // Cinematic vignette over the whole pane.
    const vignette = glass.createRadialGradient(
      width / 2, height * 0.42, Math.min(width, height) * 0.35,
      width / 2, height * 0.5, Math.max(width, height) * 0.75
    );
    vignette.addColorStop(0, "rgba(0,0,0,0)");
    vignette.addColorStop(1, "rgba(2,6,10,0.42)");
    glass.fillStyle = vignette;
    glass.fillRect(0, 0, width, height);
  }

  function spawnScan(x, y, now) {
    scans.push({
      x,
      y,
      startedAt: now,
      seed: randomInt(65536),
      readings: [random(0.42, 0.91), random(0.18, 0.84)],
      xPercent: Math.round(x / width * 100),
      yPercent: Math.round(y / height * 100),
      glyphs: Array.from({ length: 30 }, () => ({
        x: random(-88, 88),
        y: random(-62, 62),
        code: randomInt(16),
      })),
    });
  }

  function drawField(now) {
    field.clearRect(0, 0, width, height);
    field.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
    field.textAlign = "center";
    field.textBaseline = "middle";
    if (pointer && !scanTriggered && now - pointerMovedAt > 720) {
      scanTriggered = true;
      spawnScan(pointer.x, pointer.y, now);
    }
    // Random autonomous scans drift across the field on their own.
    if (!scanTriggered && scans.length < 2 && now > nextAutoScan) {
      nextAutoScan = now + random(3600, 8500);
      spawnScan(random(width * 0.14, width * 0.86), random(height * 0.14, height * 0.82), now);
    }

    scans = scans.filter(scan => (
      now - scan.startedAt < 1500 && (!scan.fadeAt || now - scan.fadeAt < 360)
    ));
    for (const scan of scans) {
      const progress = clamp((now - scan.startedAt) / 1500, 0, 1);
      const fade = scan.fadeAt ? clamp(1 - (now - scan.fadeAt) / 360, 0, 1) : 1;
      const alpha = Math.sin(progress * Math.PI) * 0.46 * fade;
      const sample = ((scan.seed + Math.floor(now / 90)) % 65536).toString(16).padStart(4, "0").toUpperCase();
      field.save();
      field.translate(scan.x, scan.y);
      field.strokeStyle = `rgba(172, 224, 177, ${alpha * 0.45})`;
      field.lineWidth = 1;
      field.beginPath();
      for (const direction of [-1, 1]) {
        field.moveTo(-90, direction * 52);
        field.lineTo(-90, direction * 64);
        field.lineTo(-78, direction * 64);
        field.moveTo(90, direction * 52);
        field.lineTo(90, direction * 64);
        field.lineTo(78, direction * 64);
      }
      field.moveTo(-90, -43 + progress * 86);
      field.lineTo(90, -43 + progress * 86);
      field.stroke();
      field.fillStyle = `rgba(198, 239, 201, ${alpha})`;
      for (const glyph of scan.glyphs) {
        const flicker = ((Math.floor(now / 95) + glyph.code) % 4) * 0.12;
        field.globalAlpha = Math.max(0, alpha - flicker);
        field.fillText("0123456789ABCDEF"[(Math.floor(now / 110) + glyph.code) % 16], glyph.x, glyph.y);
      }
      field.globalAlpha = 1;
      field.font = "9px ui-monospace, SFMono-Regular, Menlo, monospace";
      field.textAlign = "left";
      field.fillText(
        "SECTOR " + scan.xPercent.toString().padStart(2, "0") + "/" + scan.yPercent.toString().padStart(2, "0") +
        " / " + Math.floor(100 - progress * 100).toString().padStart(2, "0") + "%",
        -86,
        -51
      );
      field.fillText(
        "NDVI " + scan.readings[0].toFixed(2) + " / CANOPY " + scan.readings[1].toFixed(2),
        -86,
        -37
      );
      field.textAlign = "right";
      field.fillText("SAMPLE " + sample, 86, 54);
      field.restore();
      field.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
      field.textAlign = "center";
    }
    const activeScan = [...scans].reverse().find(scan => !scan.fadeAt);
    if (activeScan) {
      const scan = activeScan;
      setSceneTelemetry("ANALYSIS / " + scan.xPercent.toString().padStart(2, "0") + "-" + scan.yPercent.toString().padStart(2, "0"));
    } else {
      setSceneTelemetry(pointerOnPanel ? "UI / ENTRY" : pointer ? "FIELD / TRACKING" : "FIELD / PASSIVE");
    }
  }

  shell.addEventListener("pointermove", event => {
    const bounds = shell.getBoundingClientRect();
    parallaxTarget = {
      x: (event.clientX - bounds.left) / Math.max(1, bounds.width) * 2 - 1,
      y: (event.clientY - bounds.top) / Math.max(1, bounds.height) * 2 - 1,
    };
    if (event.pointerType === "touch") return;
    if (event.target.closest(".login-card-official, .auth-card")) {
      fadeScans(performance.now());
      pointer = null;
      pointerOnPanel = true;
      scanTriggered = false;
      setSceneTelemetry("UI / ENTRY");
      return;
    }
    pointerOnPanel = false;
    const next = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    if (!pointer || Math.hypot(next.x - pointer.x, next.y - pointer.y) > 14) {
      const now = performance.now();
      pointerMovedAt = now;
      scanTriggered = false;
      fadeScans(now, next);
    }
    pointer = next;
  }, { passive: true });

  shell.addEventListener("pointerleave", () => {
    fadeScans(performance.now());
    pointer = null;
    pointerOnPanel = false;
    parallaxTarget = { x: 0, y: 0 };
    scanTriggered = false;
    setSceneTelemetry("FIELD / PASSIVE");
  });

  /* ------------------------------------------------------------------ */
  /*  Photorealistic 3D scene                                            */
  /* ------------------------------------------------------------------ */

  let renderer = null;
  let composer = null;
  let scene = null;
  let camera = null;
  let bills = [];
  let noteTemplate = null;
  let windowMesh = null;
  let windUniforms = [];
  let terrainMesh = null;
  let rainLines = null;
  let rainDrops = null;
  let pendingAssets = 0;
  let shadowFrozen = false;
  let qualityIndex = 0;
  let directRender = true;
  let glassDegraded = false;
  let cloudSprites = [];
  const PIXEL_STEPS = [1.5, 1.3, 1.1, 1, 0.85];

  function addWindSway(material) {
    const uniforms = { uWindTime: { value: 0 } };
    windUniforms.push(uniforms);
    material.onBeforeCompile = shader => {
      shader.uniforms.uWindTime = uniforms.uWindTime;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nuniform float uWindTime;")
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
          #ifdef USE_INSTANCING
            vec2 ciaoPhase = instanceMatrix[3].xz;
          #else
            vec2 ciaoPhase = vec2(0.0);
          #endif
          float ciaoSway = sin(uWindTime * 1.6 + ciaoPhase.x * 0.9 + ciaoPhase.y * 0.7 + position.y * 2.4);
          float ciaoFlutter = cos(uWindTime * 2.3 + ciaoPhase.x * 1.7 - ciaoPhase.y * 1.3 + position.y * 3.1);
          transformed.x += ciaoSway * 0.055 * position.y;
          transformed.z += ciaoFlutter * 0.035 * position.y;`
        );
    };
    material.customProgramCacheKey = () => "ciaochat-foliage-wind-v1";
    material.needsUpdate = true;
  }

  function prepareFoliageMaterial(material) {
    material.side = THREE.DoubleSide;
    material.alphaTest = 0.38;
    material.transparent = false;
    material.depthWrite = true;
    material.roughness = Math.min(material.roughness ?? 0.9, 0.9);
    material.envMapIntensity = 0.22;
    addWindSway(material);
  }

  function addBillFlutter(material) {
    const uniforms = { uWindTime: { value: 0 } };
    windUniforms.push(uniforms);
    material.onBeforeCompile = shader => {
      shader.uniforms.uWindTime = uniforms.uWindTime;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nuniform float uWindTime;")
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
          float ciaoBillEdge = clamp(abs(position.x) / 1.7, 0.0, 1.0) * 0.75
                            + clamp(abs(position.z) / 1.0, 0.0, 1.0) * 0.25;
          float ciaoBillRipple = sin(uWindTime * 2.3 + modelMatrix[3].x * 1.31 + modelMatrix[3].y * 1.73 + position.x * 1.9) * 0.62
                               + sin(uWindTime * 3.9 + modelMatrix[3].z * 2.17 - position.z * 2.4) * 0.38;
          transformed.y += ciaoBillRipple * 0.11 * ciaoBillEdge * ciaoBillEdge;`
        );
    };
    material.customProgramCacheKey = () => "ciaochat-bill-flutter-v1";
    material.needsUpdate = true;
  }

  function collectParts(root) {
    root.updateMatrixWorld(true);
    const parts = [];
    root.traverse(object => {
      if (!object.isMesh || !object.geometry) return;
      const material = Array.isArray(object.material) ? object.material[0] : object.material;
      if (!material) return;
      parts.push({
        geometry: object.geometry,
        material,
        matrix: object.matrixWorld.clone(),
      });
    });
    return parts;
  }

  function scatterSpecies(root, count, area, groundFn = terrainHeightAt, scaleRange = [0.65, 1.7], wind = true, castShadows = true) {
    const parts = collectParts(root);
    if (!parts.length) return;
    const materials = [...new Set(parts.map(part => part.material))];
    for (const material of materials) {
      if (wind) prepareFoliageMaterial(material);
      else {
        material.side = THREE.DoubleSide;
        material.alphaTest = Math.max(material.alphaTest || 0, 0.38);
        material.transparent = false;
        material.depthWrite = true;
        material.envMapIntensity = 0.3;
      }
    }
    const dummy = new THREE.Object3D();
    const instances = Array.from({ length: count }, () => ({
      x: random(area.x[0], area.x[1]),
      z: random(area.z[0], area.z[1]),
      scale: random(scaleRange[0], scaleRange[1]),
      rotation: random(0, Math.PI * 2),
    }));
    for (const part of parts) {
      const instanced = new THREE.InstancedMesh(part.geometry, part.material, count);
      instanced.castShadow = castShadows;
      instanced.receiveShadow = true;
      const rel = new THREE.Matrix4().copy(part.matrix);
      for (let i = 0; i < count; i++) {
        const spot = instances[i];
        const groundY = groundFn(spot.x, spot.z);
        dummy.position.set(spot.x, groundY - 0.03, spot.z);
        dummy.rotation.set(0, spot.rotation, 0);
        dummy.scale.setScalar(spot.scale);
        dummy.updateMatrix();
        dummy.matrix.multiply(rel);
        instanced.setMatrixAt(i, dummy.matrix);
      }
      instanced.instanceMatrix.needsUpdate = true;
      scene.add(instanced);
    }
  }

  let terrainSampler = null;

  function buildTerrainSampler(mesh) {
    const position = mesh.geometry.attributes.position;
    const grid = new Map();
    const key = (x, z) => Math.round(x * 20) + "," + Math.round(z * 20);
    const vertex = new THREE.Vector3();
    for (let i = 0; i < position.count; i++) {
      vertex.set(position.getX(i), position.getY(i), position.getZ(i)).applyMatrix4(mesh.matrixWorld);
      grid.set(key(vertex.x, vertex.z), vertex.y);
    }
    terrainSampler = (x, z) => {
      for (let ring = 0; ring < 6; ring++) {
        const step = ring * 0.25;
        for (let a = 0; a < 8; a++) {
          const angle = a / 8 * Math.PI * 2;
          const hit = grid.get(key(x + Math.cos(angle) * step, z + Math.sin(angle) * step));
          if (hit !== undefined) return hit;
        }
      }
      return 0;
    };
  }

  function terrainHeightAt(x, z) {
    return terrainSampler ? terrainSampler(x, z) : 0;
  }

  function upgradeGlassMaterials(root) {
    root.traverse(object => {
      if (!object.isMesh) return;
      const name = object.name || "";
      if (name.includes("GlassPane")) {
        object.material = new THREE.MeshPhysicalMaterial({
          color: 0xffffff,
          roughness: 0.045,
          metalness: 0,
          transmission: 1,
          thickness: 0.04,
          ior: 1.33,
          clearcoat: 0.6,
          clearcoatRoughness: 0.08,
          envMapIntensity: 0.55,
          side: THREE.FrontSide,
        });
      } else if (name.includes("WaterDrop")) {
        object.material = new THREE.MeshPhysicalMaterial({
          color: 0xffffff,
          roughness: 0.02,
          metalness: 0,
          transmission: 1,
          thickness: 0.02,
          ior: 1.33,
          clearcoat: 0.8,
          clearcoatRoughness: 0.03,
          envMapIntensity: 0.65,
          side: THREE.DoubleSide,
        });
      }
      object.castShadow = false;
      object.receiveShadow = false;
    });
  }

  function layoutWindow() {
    if (!windowMesh || !camera) return;
    const bounds = shell.getBoundingClientRect();
    const aspect = Math.max(0.4, bounds.width / Math.max(1, bounds.height));
    const distance = camera.position.z - windowMesh.position.z;
    const halfHeight = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * distance;
    const neededHalfHeight = halfHeight * 1.18;
    const neededHalfWidth = halfHeight * aspect * 1.12;
    // The exported pane measures roughly 16 wide x 9 tall once upright.
    const scale = Math.max(neededHalfHeight / 4.5, neededHalfWidth / 8.0) * 0.62;
    windowMesh.scale.setScalar(scale);
    // Park the pane in the lower third of the frame along the camera's view
    // direction, so the high camera still sees the sweeping field above it.
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    const centerY = camera.position.y + dir.y * distance;
    windowMesh.position.y = centerY - halfHeight * 0.42;
  }

  // Slow-drifting cloud sprites high in the sky — cheap atmospheric depth.
  let cloudTexture = null;
  function getCloudTexture() {
    if (cloudTexture) return cloudTexture;
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 128;
    const ctx = canvas.getContext("2d");
    for (let i = 0; i < 16; i++) {
      const cx = 30 + Math.random() * 196;
      const cy = 40 + Math.random() * 48;
      const r = 18 + Math.random() * 42;
      const gradient = ctx.createRadialGradient(cx, cy, 2, cx, cy, r);
      gradient.addColorStop(0, "rgba(165,180,200,0.16)");
      gradient.addColorStop(1, "rgba(165,180,200,0)");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 256, 128);
    }
    cloudTexture = new THREE.CanvasTexture(canvas);
    return cloudTexture;
  }

  function createClouds() {
    const map = getCloudTexture();
    for (let i = 0; i < 10; i++) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map,
        color: 0x141c26,
        transparent: true,
        opacity: random(0.1, 0.2),
        depthWrite: false,
        fog: false,
      }));
      sprite.position.set(random(-380, 380), random(42, 85), random(-520, -220));
      sprite.scale.set(random(90, 170), random(28, 48), 1);
      scene.add(sprite);
      cloudSprites.push({ sprite, speed: random(0.4, 1.1) });
    }
  }

  function updateClouds(delta) {
    for (const cloud of cloudSprites) {
      cloud.sprite.position.x += cloud.speed * delta;
      if (cloud.sprite.position.x > 430) cloud.sprite.position.x = -430;
    }
  }

  // Drifting spores/motes hanging in the air — one Points draw call,
  // adds a lot of perceived detail for almost no GPU cost.
  let sporeGeometry = null;
  let sporeData = null;
  function createSpores() {
    const COUNT = 380;
    const positions = new Float32Array(COUNT * 3);
    sporeData = Array.from({ length: COUNT }, () => ({
      x: random(-36, 36),
      y: random(0.2, 13),
      z: random(-115, -5),
      speed: random(0.05, 0.22),
      phase: random(0, Math.PI * 2),
      sway: random(0.2, 0.7),
    }));
    for (let i = 0; i < COUNT; i++) {
      positions[i * 3] = sporeData[i].x;
      positions[i * 3 + 1] = sporeData[i].y;
      positions[i * 3 + 2] = sporeData[i].z;
    }
    sporeGeometry = new THREE.BufferGeometry();
    sporeGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const points = new THREE.Points(sporeGeometry, new THREE.PointsMaterial({
      color: 0xa8c8b0,
      size: 0.055,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    }));
    points.frustumCulled = false;
    scene.add(points);
  }

  function updateSpores(delta, seconds) {
    if (!sporeGeometry) return;
    const positions = sporeGeometry.attributes.position.array;
    for (let i = 0; i < sporeData.length; i++) {
      const spore = sporeData[i];
      spore.y += spore.speed * delta;
      spore.x += Math.sin(seconds * 0.6 + spore.phase) * spore.sway * delta;
      if (spore.y > 14) {
        spore.y = random(0.2, 1);
        spore.x = random(-36, 36);
        spore.z = random(-115, -5);
      }
      if (spore.x > 38) spore.x = -38;
      if (spore.x < -38) spore.x = 38;
      positions[i * 3] = spore.x;
      positions[i * 3 + 1] = spore.y;
      positions[i * 3 + 2] = spore.z;
    }
    sporeGeometry.attributes.position.needsUpdate = true;
  }

  // Last-resort degradation: transmission forces a second full scene render
  // every frame, so on very weak GPUs swap it for plain transparency.
  function degradeGlass() {
    scene.traverse(object => {
      if (!object.isMesh || !object.material) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (material.transmission > 0) {
          material.transmission = 0;
          material.transparent = true;
          material.opacity = Math.min(material.opacity || 1, 0.4);
          material.depthWrite = false;
          material.needsUpdate = true;
        }
      }
    });
  }

  function createRain() {
    const COUNT = 1300;
    const positions = new Float32Array(COUNT * 2 * 3);
    rainDrops = Array.from({ length: COUNT }, () => ({
      x: random(-55, 55),
      y: random(0, 16),
      z: random(-320, -6),
      speed: random(9, 16),
      drift: random(-0.6, 0.4),
      length: random(0.35, 0.8),
    }));
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    rainLines = new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({
        color: 0x8fa9c4,
        transparent: true,
        opacity: 0.32,
        depthWrite: false,
      })
    );
    rainLines.frustumCulled = false;
    scene.add(rainLines);
    updateRain(0);
  }

  function updateRain(delta) {
    if (!rainLines || !rainDrops) return;
    const positions = rainLines.geometry.attributes.position;
    const windX = 0.35;
    const windZ = 0.12;
    for (let i = 0; i < rainDrops.length; i++) {
      const drop = rainDrops[i];
      if (delta > 0) {
        drop.y -= drop.speed * delta;
        drop.x += (windX + drop.drift * 0.4) * delta;
        drop.z += windZ * delta;
        if (drop.y < -1) {
          drop.y = random(14, 18);
          drop.x = random(-55, 55);
          drop.z = random(-320, -6);
        }
        if (drop.x > 57) drop.x = -57;
        if (drop.x < -57) drop.x = 57;
      }
      const j = i * 6;
      positions.array[j] = drop.x;
      positions.array[j + 1] = drop.y;
      positions.array[j + 2] = drop.z;
      positions.array[j + 3] = drop.x - (windX + drop.drift * 0.4) * drop.length;
      positions.array[j + 4] = drop.y + drop.length;
      positions.array[j + 5] = drop.z - windZ * drop.length;
    }
    positions.needsUpdate = true;
  }

  function createBill() {
    if (!noteTemplate) return null;
    const clone = noteTemplate.clone(true);
    clone.traverse(object => {
      if (object.isMesh) {
        object.castShadow = false;
        object.receiveShadow = false;
        if (object.material) {
          const material = Array.isArray(object.material) ? object.material[0] : object.material;
          material.side = THREE.DoubleSide;
          material.envMapIntensity = 0.3;
        }
      }
    });
    const mesh = new THREE.Group();
    mesh.add(clone);
    // The note is modelled flat; stand it upright facing the camera.
    mesh.rotation.x = Math.PI / 2;
    const scale = random(0.5, 0.85);
    mesh.scale.setScalar(scale);
    const z = random(-3.5, 3.5);
    const halfHeight = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * (camera.position.z - z);
    mesh.position.set(
      random(-halfHeight * camera.aspect * 0.84, halfHeight * camera.aspect * 0.84),
      random(-halfHeight * 0.62, halfHeight * 0.55),
      z
    );
    scene.add(mesh);
    return {
      mesh,
      phase: random(0, Math.PI * 2),
      velocityY: random(0.25, 0.8),
      velocityX: random(-0.2, 0.2),
      gravity: random(0.7, 1.25),
      lift: random(0.08, 0.24),
      drag: random(0.035, 0.095),
      terminalVelocity: random(2.6, 4.1),
      angularX: random(-0.6, 0.6),
      angularY: random(-1.15, 1.15),
      angularZ: random(-0.7, 0.7),
      scale,
    };
  }

  function applyPixelRatio() {
    if (!renderer) return;
    const ratio = Math.min(window.devicePixelRatio || 1, PIXEL_STEPS[qualityIndex]);
    const bounds = shell.getBoundingClientRect();
    renderer.setPixelRatio(ratio);
    renderer.setSize(bounds.width, bounds.height, false);
    if (composer) {
      composer.setPixelRatio(ratio);
      composer.setSize(bounds.width, bounds.height);
    }
  }

  function resizeScene() {
    if (!renderer || !camera) return;
    const bounds = shell.getBoundingClientRect();
    const aspect = Math.max(0.4, bounds.width / Math.max(1, bounds.height));
    applyPixelRatio();
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    camera.lookAt(parallax.x * 0.2, 2.5 + parallax.y * 0.15, -45);
    layoutWindow();
    for (const bill of bills) {
      const halfHeight = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * (camera.position.z - bill.mesh.position.z);
      bill.mesh.position.x = THREE.MathUtils.clamp(bill.mesh.position.x, -halfHeight * aspect * 0.9, halfHeight * aspect * 0.9);
    }
  }

  function initializeThreeScene() {
    try {
      renderer = new THREE.WebGLRenderer({
        canvas: sceneCanvas,
        antialias: true,
        alpha: false,
        powerPreference: "high-performance",
      });
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.setClearColor(0x0a140d, 1);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 0.92;

      scene = new THREE.Scene();
      scene.background = new THREE.Color(0x070b10);
      scene.fog = new THREE.FogExp2(0x101a22, 0.016);
      camera = new THREE.PerspectiveCamera(46, 1, 0.1, 300);
      camera.position.set(0, 16, 24);
      camera.lookAt(0, 2.5, -45);

      scene.add(new THREE.HemisphereLight(0x33465c, 0x0a0f0c, 0.62));
      const keyLight = new THREE.DirectionalLight(0x8fa8cc, 0.95);
      keyLight.position.set(-9, 18, 6);
      keyLight.target.position.set(0, 0, -30);
      keyLight.castShadow = true;
      keyLight.shadow.mapSize.set(2048, 2048);
      keyLight.shadow.camera.left = -38;
      keyLight.shadow.camera.right = 38;
      keyLight.shadow.camera.top = 38;
      keyLight.shadow.camera.bottom = -38;
      keyLight.shadow.camera.near = 1;
      keyLight.shadow.camera.far = 110;
      keyLight.shadow.bias = -0.0004;
      scene.add(keyLight, keyLight.target);
      const fillLight = new THREE.DirectionalLight(0x4a5f7d, 0.35);
      fillLight.position.set(8, 6, -6);
      scene.add(fillLight);
      // Cool fill from behind the camera so the foreground ground isn't
      // pitch black at night.
      const frontFill = new THREE.DirectionalLight(0x39506e, 0.32);
      frontFill.position.set(0, 12, 26);
      frontFill.target.position.set(0, 0, -40);
      scene.add(frontFill, frontFill.target);

      createClouds();
      createRain();
      createSpores();

      // No post-processing: the DOF bokeh pass was too expensive on
      // real-world GPUs. Fog + atmospheric perspective carry the depth.
      composer = new EffectComposer(renderer);
      composer.addPass(new RenderPass(scene, camera));

      resizeScene();
      window.__ciaoScene = { scene, camera, renderer, composer };
      loadSceneAssets();
      return true;
    } catch (error) {
      renderer = null;
      console.error("[login-scene] Could not initialize the 3D scene.", error);
      return false;
    }
  }

  // Endless ground: a huge disc that continues the field past the detailed
  // terrain in every direction. Gentle rolling noise keeps the horizon from
  // looking CG-flat, the amplitude fades to zero inside the detailed
  // terrain's footprint so there's no seam, and it reuses the terrain
  // scan's soil texture so the ground reads as the same field.
  function createFarGround() {
    const size = 1800;
    const segments = 110;
    const geometry = new THREE.CircleGeometry(size / 2, segments);
    const position = geometry.attributes.position;
    // CircleGeometry lies in the XY plane; local +z becomes world +y after
    // the -90 deg X rotation, and local (x, y) maps to world (x, -z).
    // The detailed terrain occupies world |x|<=44, z in [-127,-9], which
    // maps to local x in [-44,44], y in [-151,-33].
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i);
      const y = position.getY(i);
      const ex = Math.max(0, Math.abs(x) - 44);
      const ey = Math.max(0, -151 - y) + Math.max(0, y + 33);
      const d = Math.hypot(ex, ey);
      const amp = Math.min(1, d / 45);
      const smooth = amp * amp * (3 - 2 * amp);
      const rolling =
        0.55 * Math.sin(x * 0.02 + 1.3) * Math.cos(y * 0.016) +
        1.1 * Math.sin(x * 0.006 + y * 0.009 + 2.1) * Math.cos(y * 0.012 - 1.0) +
        0.35 * Math.sin(x * 0.05 + y * 0.03);
      position.setZ(i, -0.72 + smooth * rolling);
    }
    geometry.computeVertexNormals();

    let map = null;
    if (terrainMesh) {
      const material = Array.isArray(terrainMesh.material) ? terrainMesh.material[0] : terrainMesh.material;
      if (material && material.map) {
        map = material.map.clone();
        map.wrapS = map.wrapT = THREE.RepeatWrapping;
        map.repeat.set(90, 90);
        map.needsUpdate = true;
      }
    }
    const farGround = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({
        map,
        color: map ? 0x9aa48e : 0x131a10,
        roughness: 1,
        metalness: 0,
        envMapIntensity: 0.15,
      })
    );
    farGround.rotation.x = -Math.PI / 2;
    farGround.position.set(0, 0, -160);
    farGround.receiveShadow = true;
    scene.add(farGround);
  }

  function loadSceneAssets() {
    const gltfLoader = new GLTFLoader();
    const hdrLoader = new RGBELoader();

    // Track in-flight GLB loads so the shadow map can freeze once the
    // (fully static) casters are all in place.
    const rawGltfLoad = gltfLoader.load.bind(gltfLoader);
    gltfLoader.load = function (url, onLoad, onProgress, onError) {
      pendingAssets += 1;
      const settle = callback => callback && ((...args) => {
        pendingAssets = Math.max(0, pendingAssets - 1);
        return callback(...args);
      });
      return rawGltfLoad(url, settle(onLoad), onProgress, settle(onError));
    };

    hdrLoader.load(
      ASSET_BASE + "autumn-field-2k.hdr",
      hdrTexture => {
        try {
          hdrTexture.mapping = THREE.EquirectangularReflectionMapping;
          scene.background = hdrTexture;
          if ("backgroundIntensity" in scene) scene.backgroundIntensity = 0.32;
          if ("backgroundBlurriness" in scene) scene.backgroundBlurriness = 0.55;
          const pmrem = new THREE.PMREMGenerator(renderer);
          pmrem.compileCubemapShader();
          scene.environment = pmrem.fromEquirectangular(hdrTexture).texture;
          pmrem.dispose();
          scene.traverse(object => {
            if (object.material) object.material.needsUpdate = true;
          });
        } catch (error) {
          console.error("[login-scene] Could not apply the HDR environment.", error);
        }
      },
      undefined,
      error => console.error("[login-scene] Could not load the HDR environment.", error)
    );

    // Trees stand on the detailed terrain inside its footprint and on the
    // far ground plane beyond it.
    function treeHeightAt(x, z) {
      if (Math.abs(x) <= 44 && z >= -126 && z <= -10) return terrainHeightAt(x, z) - 0.06;
      return -0.72;
    }
    const TREES = [
      { file: "trees/fir_tree_01/fir_tree_01.glb", count: 12, area: { x: [-46, 46], z: [-118, -32] }, scale: [0.7, 1.5] },
      { file: "trees/island_tree_01/island_tree_01.glb", count: 16, area: { x: [-46, 46], z: [-116, -34] }, scale: [0.8, 1.7] },
    ];

    // Field-edge light poles receding into the night, alternating the two
    // Poly Haven lamp models. Each gets a glow sprite at the head and a soft
    // additive pool of light on the ground — no dynamic lights needed.
    const LAMP_FILES = [
      "lamps/street_lamp_01/street_lamp_01.glb",
      "lamps/street_lamp_02/street_lamp_02.glb",
    ];
    const LAMP_SPOTS = [
      { file: 0, x: -20, z: -34 }, { file: 1, x: 21, z: -38 },
      { file: 0, x: -23, z: -64 }, { file: 1, x: 24, z: -70 },
      { file: 0, x: -26, z: -98 }, { file: 1, x: 27, z: -106 },
      { file: 1, x: -21, z: -128 }, { file: 0, x: 22, z: -136 },
    ];
    const lampScenes = [];

    let glowTexture = null;
    function getGlowTexture() {
      if (glowTexture) return glowTexture;
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 128;
      const ctx = canvas.getContext("2d");
      const gradient = ctx.createRadialGradient(64, 64, 2, 64, 64, 64);
      gradient.addColorStop(0, "rgba(255,255,255,1)");
      gradient.addColorStop(0.35, "rgba(255,255,255,0.4)");
      gradient.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 128, 128);
      glowTexture = new THREE.CanvasTexture(canvas);
      return glowTexture;
    }

    function placeLamps() {
      const glowMap = getGlowTexture();
      for (const spot of LAMP_SPOTS) {
        const source = lampScenes[spot.file];
        if (!source) continue;
        const lamp = source.clone(true);
        const scale = random(0.9, 1.15);
        lamp.scale.setScalar(scale);
        lamp.rotation.y = random(0, Math.PI * 2);
        lamp.traverse(object => {
          if (object.isMesh) {
            object.castShadow = true;
            object.receiveShadow = true;
            if (object.material) object.material.envMapIntensity = 0.3;
          }
        });
        scene.add(lamp);
        lamp.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(lamp);
        const groundY = treeHeightAt(spot.x, spot.z);
        lamp.position.set(spot.x, groundY - box.min.y, spot.z);
        lamp.updateMatrixWorld(true);
        const placed = new THREE.Box3().setFromObject(lamp);
        const height = Math.max(0.1, placed.max.y - placed.min.y);
        const head = new THREE.Vector3(
          (placed.min.x + placed.max.x) / 2,
          placed.max.y - height * 0.1,
          (placed.min.z + placed.max.z) / 2
        );
        const glow = new THREE.Sprite(new THREE.SpriteMaterial({
          map: glowMap,
          color: 0xffb066,
          transparent: true,
          opacity: 0.75,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          fog: false,
        }));
        glow.position.copy(head);
        glow.scale.setScalar(clamp(height * 0.55, 1.2, 3.2));
        scene.add(glow);
        const poolRadius = clamp(height * 0.85, 3, 7);
        const pool = new THREE.Mesh(
          new THREE.CircleGeometry(poolRadius, 40),
          new THREE.MeshBasicMaterial({
            map: glowMap,
            color: 0xff9a4d,
            transparent: true,
            opacity: 0.15,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            fog: false,
          })
        );
        pool.rotation.x = -Math.PI / 2;
        pool.position.set(spot.x, groundY + 0.04, spot.z);
        scene.add(pool);
      }
    }

    const FIELD_AREA = { x: [-30, 30], z: [-108, -24] };
    const SPECIES = [
      { file: "grass-medium-02.glb", count: 30 },
      { file: "grass-bermuda-01.glb", count: 56 },
      { file: "nettle-plant.glb", count: 14 },
    ];

    gltfLoader.load(ASSET_BASE + "farm-terrain.glb", gltf => {
      try {
        const terrain = gltf.scene;
        terrain.rotation.y = Math.PI;
        terrain.scale.setScalar(1.55);
        terrain.position.set(0, -0.04, -68);
        terrain.traverse(object => {
          if (object.isMesh) {
            object.castShadow = false;
            object.receiveShadow = true;
            if (object.material) object.material.envMapIntensity = 0.3;
          }
        });
        scene.add(terrain);
        terrainMesh = terrain.children.find(child => child.isMesh) || null;
        if (!terrainMesh) terrain.traverse(object => { if (object.isMesh && !terrainMesh) terrainMesh = object; });
        terrain.updateMatrixWorld(true);
        buildTerrainSampler(terrainMesh);
        createFarGround();
        for (const species of SPECIES) {
          gltfLoader.load(ASSET_BASE + species.file, plant => {
            scatterSpecies(plant.scene, species.count, FIELD_AREA);
          }, undefined, error => console.error(`[login-scene] Could not load ${species.file}.`, error));
        }
        for (const tree of TREES) {
          gltfLoader.load(ASSET_BASE + tree.file, plant => {
            scatterSpecies(plant.scene, tree.count, tree.area, treeHeightAt, tree.scale, false, false);
          }, undefined, error => console.error(`[login-scene] Could not load ${tree.file}.`, error));
        }
        let lampsLoaded = 0;
        LAMP_FILES.forEach((file, index) => {
          gltfLoader.load(ASSET_BASE + file, lamp => {
            lampScenes[index] = lamp.scene;
            lampsLoaded += 1;
            if (lampsLoaded === LAMP_FILES.length) placeLamps();
          }, undefined, error => console.error(`[login-scene] Could not load ${file}.`, error));
        });
      } catch (error) {
        console.error("[login-scene] Could not place the farm terrain.", error);
      }
    }, undefined, error => console.error("[login-scene] Could not load the farm terrain.", error));

    gltfLoader.load(ASSET_BASE + "glass-window.glb", gltf => {
      try {
        const windowModel = gltf.scene;
        windowModel.rotation.x = Math.PI / 2;
        windowModel.position.set(0, 1.3, -5);
        upgradeGlassMaterials(windowModel);
        scene.add(windowModel);
        windowMesh = windowModel;
        layoutWindow();
      } catch (error) {
        console.error("[login-scene] Could not place the glass window.", error);
      }
    }, undefined, error => console.error("[login-scene] Could not load the glass window.", error));

    gltfLoader.load(ASSET_BASE + "ciao-credit-note.glb", gltf => {
      try {
        noteTemplate = gltf.scene;
        const fluttered = new Set();
        noteTemplate.traverse(object => {
          if (!object.isMesh || !object.material) return;
          const material = Array.isArray(object.material) ? object.material[0] : object.material;
          if (material && !fluttered.has(material)) {
            fluttered.add(material);
            addBillFlutter(material);
          }
        });
        const count = width < 640 ? 8 : 13;
        bills = Array.from({ length: count }, () => createBill()).filter(Boolean);
        resizeScene();
        assetsReady = true;
        if (reducedMotionQuery.matches || document.body.classList.contains("reduced-motion") || !running) {
          renderStaticScene(performance.now());
        }
      } catch (error) {
        console.error("[login-scene] Could not load the credit note model.", error);
      }
    }, undefined, error => console.error("[login-scene] Could not load the credit note model.", error));
  }

  /* ------------------------------------------------------------------ */
  /*  Flying banknotes (DOM layer used with the video backdrop)          */
  /* ------------------------------------------------------------------ */

  let banknotes = [];
  let noteTextures = null;

  function makeNoteTextures() {
    const W = 440;
    const H = 190;
    const INK = "#1c6b3d";
    const INK_DARK = "#0d4a29";
    const INK_LIGHT = "#2f8f57";
    const variants = [];

    for (let v = 0; v < 3; v++) {
      const canvas = document.createElement("canvas");
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext("2d");

      const paper = ctx.createLinearGradient(0, 0, W, H);
      paper.addColorStop(0, "#f2f7e8");
      paper.addColorStop(0.4, "#e2eed4");
      paper.addColorStop(0.75, "#d2dfc0");
      paper.addColorStop(1, "#c2d2ae");
      ctx.fillStyle = paper;
      ctx.fillRect(0, 0, W, H);

      // laid paper: faint horizontal chain lines + fibre speckle
      ctx.strokeStyle = "rgba(110,135,95,0.08)";
      ctx.lineWidth = 0.6;
      for (let y = 4; y < H; y += 4) {
        ctx.beginPath();
        ctx.moveTo(0, y + Math.sin(y * 0.7) * 0.4);
        ctx.lineTo(W, y);
        ctx.stroke();
      }
      ctx.fillStyle = "rgba(120,140,100,0.10)";
      for (let i = 0; i < 700; i++) {
        ctx.fillRect(Math.random() * W, Math.random() * H, 1.3, 0.7);
      }
      // aged edge darkening
      const vign = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, W * 0.62);
      vign.addColorStop(0, "rgba(0,0,0,0)");
      vign.addColorStop(1, "rgba(60,80,45,0.16)");
      ctx.fillStyle = vign;
      ctx.fillRect(0, 0, W, H);

      const serialA = `L${(10000000 + v * 7919 + Math.floor(Math.random() * 89999999))}`;
      const serialB = `${String.fromCharCode(65 + v)}${Math.floor(10000000 + Math.random() * 89999999)}`;

      // watermark: oversized faint denomination
      ctx.save();
      ctx.globalAlpha = 0.07;
      ctx.fillStyle = INK_DARK;
      ctx.font = "700 120px Georgia, serif";
      ctx.textAlign = "center";
      ctx.fillText("100", W * 0.68, H * 0.78);
      ctx.restore();

      // frame: outer + inner hairlines with corner rosettes
      ctx.strokeStyle = INK;
      ctx.lineWidth = 3;
      ctx.strokeRect(4, 4, W - 8, H - 8);
      ctx.lineWidth = 1;
      ctx.strokeRect(11, 11, W - 22, H - 22);
      ctx.strokeStyle = INK_LIGHT;
      ctx.lineWidth = 0.8;
      ctx.strokeRect(15, 15, W - 30, H - 30);
      // corner flourishes
      ctx.strokeStyle = INK;
      for (const [cx, cy, sx, sy] of [[18, 18, 1, 1], [W - 18, 18, -1, 1], [18, H - 18, 1, -1], [W - 18, H - 18, -1, -1]]) {
        ctx.beginPath();
        ctx.arc(cx + 14 * sx, cy + 10 * sy, 9, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx + 22 * sx, cy + 18 * sy, 5, 0, Math.PI * 2);
        ctx.stroke();
      }

      // guilloche rosette behind portrait
      const gx = W * 0.30;
      const gy = H * 0.5;
      ctx.save();
      ctx.strokeStyle = "rgba(31,143,87,0.30)";
      ctx.lineWidth = 0.7;
      for (let ring = 0; ring < 14; ring++) {
        ctx.beginPath();
        const baseR = 16 + ring * 4.4;
        for (let a = 0; a <= Math.PI * 2 + 0.05; a += 0.08) {
          const r = baseR + Math.sin(a * 9 + ring * 1.3) * 2.6;
          const px = gx + Math.cos(a) * r;
          const py = gy + Math.sin(a) * r * 0.82;
          if (a === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
      ctx.restore();

      // portrait oval: engraved bust of Franklin
      const px = gx, py = gy;
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(px, py, 30, 42, 0, 0, Math.PI * 2);
      ctx.clip();
      const bust = ctx.createLinearGradient(px - 30, py, px + 30, py);
      bust.addColorStop(0, "#0d4a29");
      bust.addColorStop(1, "#1c6b3d");
      ctx.fillStyle = bust;
      ctx.fillRect(px - 32, py - 44, 64, 88);
      // head
      ctx.fillStyle = "#0d4a29";
      ctx.beginPath();
      ctx.ellipse(px, py - 14, 12.5, 15.5, 0, 0, Math.PI * 2);
      ctx.fill();
      // shoulders / coat
      ctx.beginPath();
      ctx.moveTo(px - 24, py + 44);
      ctx.quadraticCurveTo(px - 22, py + 6, px - 9, py + 1);
      ctx.lineTo(px + 9, py + 1);
      ctx.quadraticCurveTo(px + 22, py + 6, px + 24, py + 44);
      ctx.closePath();
      ctx.fill();
      // engraving hatch lines
      ctx.strokeStyle = "rgba(200,230,205,0.5)";
      ctx.lineWidth = 0.6;
      for (let i = -28; i <= 28; i += 3.5) {
        ctx.beginPath();
        ctx.moveTo(px + i, py - 38);
        ctx.lineTo(px + i + 10, py + 42);
        ctx.stroke();
      }
      ctx.restore();
      // oval frame
      ctx.strokeStyle = INK_DARK;
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.ellipse(px, py, 30, 42, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.ellipse(px, py, 34, 46, 0, 0, Math.PI * 2);
      ctx.stroke();

      // name under portrait
      ctx.textAlign = "center";
      ctx.fillStyle = INK_DARK;
      ctx.font = "700 11px Georgia, 'Times New Roman', serif";
      ctx.fillText("BENJAMIN FRANKLIN", px, py + 56);

      // left seal: Treasury-style star seal
      const sx = W * 0.115;
      const sy = H * 0.42;
      ctx.strokeStyle = INK_DARK;
      ctx.fillStyle = "rgba(28,107,61,0.12)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sx, sy, 17, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(sx, sy, 13.5, 0, Math.PI * 2);
      ctx.lineWidth = 0.8;
      ctx.stroke();
      // radial spokes + star
      ctx.lineWidth = 0.7;
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(sx + Math.cos(a) * 4, sy + Math.sin(a) * 4);
        ctx.lineTo(sx + Math.cos(a) * 12.5, sy + Math.sin(a) * 12.5);
        ctx.stroke();
      }
      ctx.fillStyle = INK_DARK;
      ctx.beginPath();
      for (let i = 0; i < 5; i++) {
        const a = -Math.PI / 2 + (i * 4 * Math.PI) / 5;
        const x = sx + Math.cos(a) * 6.5;
        const y = sy + Math.sin(a) * 6.5;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
      ctx.font = "8px ui-monospace, monospace";
      ctx.fillText("TREASURY", sx, sy + 24);

      // right seal: Federal Reserve letter
      const rx = W * 0.885;
      const ry = H * 0.42;
      ctx.strokeStyle = INK_DARK;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(rx, ry, 17, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(rx, ry, 13.5, 0, Math.PI * 2);
      ctx.lineWidth = 0.8;
      ctx.stroke();
      ctx.font = "700 19px Georgia, serif";
      ctx.fillStyle = INK_DARK;
      ctx.fillText("B", rx, ry + 7);
      ctx.font = "8px ui-monospace, monospace";
      ctx.fillText("FEDERAL RESERVE", rx, ry + 24);

      // security thread: translucent strip with microtext
      const threadX = W * 0.80;
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = "#bcd8c4";
      ctx.fillRect(threadX - 7, 20, 14, H - 40);
      ctx.strokeStyle = INK_LIGHT;
      ctx.lineWidth = 0.8;
      ctx.strokeRect(threadX - 7, 20, 14, H - 40);
      ctx.translate(threadX, H / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillStyle = INK_DARK;
      ctx.font = "7px ui-monospace, monospace";
      ctx.textAlign = "center";
      for (let i = -3; i <= 3; i++) ctx.fillText("USA 100 ", i * 46, 0);
      ctx.restore();

      // microprint along the inner border
      ctx.fillStyle = "rgba(13,74,41,0.5)";
      ctx.font = "4.5px ui-monospace, monospace";
      ctx.textAlign = "left";
      for (let x = 24; x < W - 30; x += 78) ctx.fillText("THE UNITED STATES OF AMERICA ", x, 23.5);
      for (let x = 24; x < W - 30; x += 78) ctx.fillText("ONE HUNDRED DOLLARS ", x, H - 18.5);

      // top inscription
      ctx.font = "700 12.5px Georgia, 'Times New Roman', serif";
      ctx.fillStyle = INK_DARK;
      ctx.fillText("THE UNITED STATES OF AMERICA", W / 2, 36);
      ctx.font = "9.5px Georgia, serif";
      ctx.fillStyle = INK;
      ctx.fillText("ONE HUNDRED DOLLARS", W / 2, H - 42);

      // serial numbers
      ctx.font = "700 11px ui-monospace, monospace";
      ctx.fillStyle = INK_DARK;
      ctx.fillText(serialA, 32, 26);
      ctx.fillText(serialB, W - 32, 26);
      ctx.fillText(serialB, 32, H - 16);
      ctx.fillText(serialA, W - 32, H - 16);

      // denomination numerals in corners
      ctx.font = "700 16px Georgia, serif";
      ctx.fillText("100", 24, 48);
      ctx.fillText("100", W - 24, 48);
      ctx.fillText("100", 24, H - 26);
      ctx.fillText("100", W - 24, H - 26);
      // small stars flanking header
      ctx.font = "11px Georgia, serif";
      ctx.fillText("✦", W / 2 - 168, 36);
      ctx.fillText("✦", W / 2 + 168, 36);

      variants.push(canvas.toDataURL("image/png"));
    }
    return variants;
  }

  function createBanknotes() {
    if (!noteTextures) noteTextures = makeNoteTextures();
    const count = Math.max(10, Math.min(18, Math.round((width || 1280) / 95)));
    for (let i = 0; i < count; i++) {
      const el = document.createElement("div");
      el.className = "fly-note";
      el.style.backgroundImage = `url(${noteTextures[i % noteTextures.length]})`;
      const depth = random(0.25, 1);
      el.style.filter = `hue-rotate(${random(-8, 8)}deg) brightness(${random(0.82, 1.08)}) blur(${((1 - depth) * 1.4).toFixed(2)}px) drop-shadow(0 ${6 + depth * 8}px ${10 + depth * 12}px rgba(0,0,0,${(0.25 + depth * 0.25).toFixed(2)}))`;
      shell.appendChild(el);
      banknotes.push({
        el,
        x: random(-80, (width || 1280) + 80),
        y: random(-(height || 800) * 0.9, (height || 800) * 0.4),
        vx: random(-28, 28),
        vy: random(50, 120),
        terminal: random(150, 260),
        phase: random(0, Math.PI * 2),
        rotBase: random(-0.5, 0.5),
        spin: random(-0.7, 0.7),
        depth,
        scale: 0.55 + depth * 0.65,
      });
    }
  }

  function updateBanknotes(delta, seconds) {
    for (const note of banknotes) {
      note.vy = Math.min(note.terminal, note.vy + 320 * delta);
      note.y += note.vy * delta * (0.7 + note.depth * 0.6);
      note.x += (note.vx + Math.sin(seconds * 1.2 + note.phase) * 26) * delta * (0.7 + note.depth * 0.6);
      note.rotBase += note.spin * delta;
      if (note.y > (height || 800) + 90) {
        note.y = random(-140, -30);
        note.x = random(-80, (width || 1280) + 80);
        note.vy = random(40, 110);
      }
      if (note.x > (width || 1280) + 120) note.x = -120;
      if (note.x < -140) note.x = (width || 1280) + 100;
      const flutter = Math.sin(seconds * (1.9 + note.depth) + note.phase);
      const flex = Math.sin(seconds * 2.7 + note.phase * 2.1);
      const rot = note.rotBase + flutter * 0.38;
      const skew = flex * 0.14;
      const squash = 1 + flex * 0.05;
      note.el.style.transform =
        `translate3d(${note.x.toFixed(1)}px, ${note.y.toFixed(1)}px, 0) ` +
        `rotate(${rot.toFixed(3)}rad) skewY(${skew.toFixed(3)}rad) ` +
        `scale(${note.scale.toFixed(3)}, ${(note.scale * squash).toFixed(3)})`;
    }
  }

  function animate(now) {
    if (!running || authShellHidden()) return;
    if (!animate.startedAt) animate.startedAt = now;
    const delta = Math.min(0.04, Math.max(0, (now - (animate.lastTime || now)) / 1000));
    const seconds = now / 1000;
    const reducedMotion = reducedMotionQuery.matches || document.body.classList.contains("reduced-motion");
    animate.lastTime = now;
    for (const uniforms of windUniforms) uniforms.uWindTime.value = reducedMotion ? 0 : seconds;
    if (!reducedMotion) {
      parallax.x += (parallaxTarget.x - parallax.x) * Math.min(1, delta * 2.4);
      parallax.y += (parallaxTarget.y - parallax.y) * Math.min(1, delta * 2.4);
    }
    drawGlass(now, delta);
    drawField(now);
    if (!reducedMotion) {
      updateRain(delta);
      updateClouds(delta);
      updateSpores(delta, seconds);
      updateBanknotes(delta, seconds);
    }
    if (renderer && scene && camera) {
      if (!reducedMotion) {
        camera.position.x = parallax.x * 0.7;
        camera.position.y = 16 - parallax.y * 0.6;
        camera.lookAt(parallax.x * 0.2, 2.5 - parallax.y * 0.15, -45);
      }
      if (!reducedMotion) {
        for (const bill of bills) {
          const { mesh, phase } = bill;
          const lift = Math.sin(seconds * 2.3 + phase) * bill.lift;
          bill.velocityY = clamp(bill.velocityY + (bill.gravity - lift) * delta, 0.12, bill.terminalVelocity);
          bill.velocityY *= Math.max(0, 1 - bill.drag * delta);
          bill.velocityX += (Math.sin(seconds * 0.7 + phase) * 0.09 + Math.cos(seconds * 0.31 + phase) * 0.035) * delta;
          bill.velocityX *= Math.max(0, 1 - delta * 0.12);
          mesh.position.y -= bill.velocityY * delta;
          mesh.position.x += bill.velocityX * delta + Math.sin(seconds * 1.7 + phase) * delta * 0.15;
          mesh.rotation.x += bill.angularX * delta + Math.sin(seconds * 2.1 + phase) * delta * 0.38;
          mesh.rotation.y += bill.angularY * delta + Math.cos(seconds * 1.6 + phase) * delta * 0.34;
          mesh.rotation.z += bill.angularZ * delta + Math.sin(seconds * 1.1 + phase) * delta * 0.12;
          const halfHeight = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * (camera.position.z - mesh.position.z);
          const halfWidth = halfHeight * camera.aspect;
          if (mesh.position.y < -halfHeight - 2) {
            mesh.position.y = halfHeight + random(1, 5);
            mesh.position.x = random(-halfWidth * 0.82, halfWidth * 0.82);
            bill.velocityY = random(0.25, 0.8);
            bill.velocityX = random(-0.2, 0.2);
          }
        }
      }
      if (composer && !directRender) composer.render();
      else renderer.render(scene, camera);

      // Adaptive resolution: step the pixel ratio down when the GPU can't
      // hold ~45 fps, back up when it has headroom. 2 s windows keep it
      // from oscillating. If resolution alone isn't enough, shed post
      // processing and finally the glass transmission pass.
      animate.fpsFrames = (animate.fpsFrames || 0) + 1;
      animate.fpsWindow = (animate.fpsWindow || 0) + delta;
      if (animate.fpsWindow >= 2) {
        const fps = animate.fpsFrames / animate.fpsWindow;
        animate.fpsFrames = 0;
        animate.fpsWindow = 0;
        if (fps < 45 && qualityIndex < PIXEL_STEPS.length - 1) {
          qualityIndex += 1;
          applyPixelRatio();
        } else if (fps > 57 && qualityIndex > 0) {
          qualityIndex -= 1;
          applyPixelRatio();
        } else if (fps < 30 && qualityIndex === PIXEL_STEPS.length - 1 && !glassDegraded) {
          glassDegraded = true;
          degradeGlass();
        }
      }

      // The scene's shadow casters are static once every GLB has landed;
      // freeze the shadow map so it isn't re-rendered every frame.
      if (!shadowFrozen && pendingAssets === 0 && now - (animate.startedAt || now) > 8000) {
        renderer.shadowMap.autoUpdate = false;
        renderer.shadowMap.needsUpdate = true;
        shadowFrozen = true;
      }
    }
    if (running && !reducedMotionQuery.matches && !document.body.classList.contains("reduced-motion")) {
      frame = requestAnimationFrame(animate);
    } else {
      running = false;
    }
  }

  function authShellHidden() {
    return shell.style.display === "none";
  }

  function startAnimation() {
    if (running || authShellHidden() || reducedMotionQuery.matches || document.body.classList.contains("reduced-motion")) return;
    running = true;
    frame = requestAnimationFrame(animate);
  }

  function stopAnimation() {
    running = false;
    cancelAnimationFrame(frame);
  }

  function renderStaticScene(now = performance.now()) {
    drawGlass(now, 0, true);
    drawField(now);
    if (renderer && scene && camera && assetsReady) {
      if (composer) composer.render();
      else renderer.render(scene, camera);
    }
  }

  resizeField();
  if ("ResizeObserver" in window) {
    resizeObserver = new ResizeObserver(resizeField);
    resizeObserver.observe(shell);
  }
  window.addEventListener("resize", resizeField, { passive: true });
  if (!useVideoBg) initializeThreeScene();
  else createBanknotes();
  const visibilityObserver = new MutationObserver(() => {
    if (authShellHidden()) {
      stopAnimation();
    } else if (reducedMotionQuery.matches || document.body.classList.contains("reduced-motion")) {
      stopAnimation();
      renderStaticScene();
    } else {
      startAnimation();
    }
  });
  visibilityObserver.observe(shell, { attributes: true, attributeFilter: ["style"] });
  visibilityObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  if (reducedMotionQuery.matches || document.body.classList.contains("reduced-motion")) {
    renderStaticScene();
  } else {
    startAnimation();
  }

  reducedMotionQuery.addEventListener?.("change", () => {
    stopAnimation();
    if (reducedMotionQuery.matches || document.body.classList.contains("reduced-motion")) {
      renderStaticScene();
    } else {
      startAnimation();
    }
  });

  function resizeField() {
    const bounds = shell.getBoundingClientRect();
    width = Math.max(1, bounds.width);
    height = Math.max(1, bounds.height);
    pixelRatio = Math.min(window.devicePixelRatio || 1, 1.4);
    for (const canvas of [glassCanvas, sceneCanvas, fieldCanvas]) {
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    field.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    glass.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    if (renderer) {
      resizeScene();
      if (reducedMotionQuery.matches || document.body.classList.contains("reduced-motion")) {
        renderStaticScene(performance.now());
      }
    }
    drawGlass(performance.now(), 0, true);
    drawField(performance.now());
  }
})();
