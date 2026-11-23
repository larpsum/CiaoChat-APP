import * as THREE from "./vendor/three.module.js";
import { GLTFLoader } from "./vendor/loaders/GLTFLoader.js";
import { RGBELoader } from "./vendor/loaders/RGBELoader.js";
import { EffectComposer } from "./vendor/postprocessing/EffectComposer.js";
import { RenderPass } from "./vendor/postprocessing/RenderPass.js";
import { BokehPass } from "./vendor/postprocessing/BokehPass.js";

(() => {
  const shell = document.getElementById("authShell");
  const sceneCanvas = document.getElementById("loginScene");
  const fieldCanvas = document.getElementById("asciiField");
  const glassCanvas = document.getElementById("glassPane");
  const sceneTelemetry = document.getElementById("sceneTelemetry");
  const fieldStatus = document.getElementById("fieldStatus");
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
  let raindrops = [];
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

  function createRaindrops() {
    const count = Math.min(96, Math.round(width * height / 12500));
    raindrops = Array.from({ length: count }, () => ({
      x: random(0, width),
      y: random(0, height),
      radius: random(1.1, 3.8),
      speed: random(2, 14),
      gravity: random(18, 34),
      maxSpeed: random(36, 82),
      slipDelay: random(0.35, 1.4),
      drift: random(-7, 7),
      tail: random(7, 31),
      phase: random(0, Math.PI * 2),
      focus: random(0, 1),
    }));
  }

  function drawGlass(now, delta, force = false) {
    if (!force && now - lastGlassDraw < 24) return;
    lastGlassDraw = now;
    const moving = !force && !reducedMotionQuery.matches && !document.body.classList.contains("reduced-motion");
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

    for (const drop of raindrops) {
      if (moving) {
        drop.phase += delta * 1.4;
        drop.slipDelay -= delta;
        if (drop.slipDelay <= 0 && drop.speed > drop.maxSpeed * 0.62) {
          drop.speed *= random(0.2, 0.42);
          drop.slipDelay = random(0.5, 1.5);
        }
        drop.speed = Math.min(drop.maxSpeed, drop.speed + drop.gravity * delta);
        drop.y += drop.speed * delta;
        drop.x += (drop.drift + Math.sin(drop.phase) * 2) * delta;
        if (drop.y - drop.tail > height) {
          drop.y = -random(8, height * 0.3);
          drop.x = random(0, width);
          drop.speed = random(2, 14);
          drop.gravity = random(18, 34);
          drop.maxSpeed = random(36, 82);
          drop.slipDelay = random(0.35, 1.4);
        }
      }
      const radius = drop.radius;
      const x = drop.x + (moving ? Math.sin(drop.phase) * 0.8 : 0);
      const trailAlpha = drop.focus > 0.58 ? 0.12 : 0.055;
      glass.save();
      glass.lineCap = "round";
      glass.strokeStyle = `rgba(226, 246, 235, ${trailAlpha})`;
      glass.lineWidth = Math.max(0.6, radius * 0.48);
      glass.beginPath();
      glass.moveTo(x - drop.drift * 0.025, drop.y - drop.tail);
      glass.quadraticCurveTo(x + radius * 0.2, drop.y - drop.tail * 0.42, x, drop.y - radius);
      glass.stroke();

      const lens = glass.createRadialGradient(x - radius * 0.4, drop.y - radius * 0.55, 0.2, x, drop.y, radius * 1.8);
      lens.addColorStop(0, "rgba(250, 255, 252, 0.48)");
      lens.addColorStop(0.26, "rgba(207, 238, 222, 0.2)");
      lens.addColorStop(0.67, "rgba(112, 160, 137, 0.12)");
      lens.addColorStop(1, "rgba(240, 252, 245, 0.02)");
      glass.fillStyle = lens;
      glass.beginPath();
      glass.ellipse(x, drop.y, radius * 0.76, radius * 1.42, drop.drift * 0.012, 0, Math.PI * 2);
      glass.fill();
      glass.strokeStyle = `rgba(237, 250, 242, ${0.19 + drop.focus * 0.13})`;
      glass.lineWidth = 0.55;
      glass.stroke();
      glass.strokeStyle = "rgba(255, 255, 255, 0.52)";
      glass.lineWidth = Math.max(0.45, radius * 0.2);
      glass.beginPath();
      glass.moveTo(x - radius * 0.32, drop.y - radius * 0.48);
      glass.quadraticCurveTo(x - radius * 0.1, drop.y - radius * 0.68, x + radius * 0.08, drop.y - radius * 0.64);
      glass.stroke();
      glass.restore();
    }
  }

  function drawField(now) {
    field.clearRect(0, 0, width, height);
    field.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
    field.textAlign = "center";
    field.textBaseline = "middle";
    if (pointer && !scanTriggered && now - pointerMovedAt > 720) {
      scanTriggered = true;
      const xPercent = Math.round(pointer.x / width * 100);
      const yPercent = Math.round(pointer.y / height * 100);
      scans.push({
        x: pointer.x,
        y: pointer.y,
        startedAt: now,
        seed: randomInt(65536),
        readings: [random(0.42, 0.91), random(0.18, 0.84)],
        xPercent,
        yPercent,
        glyphs: Array.from({ length: 30 }, () => ({
          x: random(-88, 88),
          y: random(-62, 62),
          code: randomInt(16),
        })),
      });
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
  let bokehDisabled = false;
  const PIXEL_STEPS = [2, 1.6, 1.3, 1.1, 1];

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
    const scale = Math.max(neededHalfHeight / 4.5, neededHalfWidth / 8.0) * 1.15;
    windowMesh.scale.setScalar(scale);
    windowMesh.position.y = camera.position.y - 0.55;
  }

  function createRain() {
    const COUNT = 900;
    const positions = new Float32Array(COUNT * 2 * 3);
    rainDrops = Array.from({ length: COUNT }, () => ({
      x: random(-34, 34),
      y: random(0, 16),
      z: random(-115, -6),
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
          drop.x = random(-34, 34);
          drop.z = random(-115, -6);
        }
        if (drop.x > 36) drop.x = -36;
        if (drop.x < -36) drop.x = 36;
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
    camera.lookAt(parallax.x * 0.17, 1.1 + parallax.y * 0.12, -12);
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
      camera = new THREE.PerspectiveCamera(42, 1, 0.1, 220);
      camera.position.set(0, 1.85, 14);
      camera.lookAt(0, 1.1, -12);

      scene.add(new THREE.HemisphereLight(0x33465c, 0x0a0f0c, 0.5));
      const keyLight = new THREE.DirectionalLight(0x8fa8cc, 0.85);
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

      // Endless ground plane: continues the field past the detailed terrain
      // edge and dissolves into the night fog at the horizon.
      const farGround = new THREE.Mesh(
        new THREE.CircleGeometry(620, 72),
        new THREE.MeshStandardMaterial({
          color: 0x131a10,
          roughness: 1,
          metalness: 0,
          envMapIntensity: 0.15,
        })
      );
      farGround.rotation.x = -Math.PI / 2;
      farGround.position.set(0, -0.72, -160);
      farGround.receiveShadow = true;
      scene.add(farGround);

      createRain();

      composer = new EffectComposer(renderer);
      composer.addPass(new RenderPass(scene, camera));
      composer.addPass(new BokehPass(scene, camera, {
        focus: 13.5,
        aperture: 0.014,
        maxblur: 0.0035,
      }));

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
      { file: "trees/fir_tree_01/fir_tree_01.glb", count: 9, area: { x: [-46, 46], z: [-118, -32] }, scale: [0.7, 1.5] },
      { file: "trees/island_tree_01/island_tree_01.glb", count: 12, area: { x: [-46, 46], z: [-116, -34] }, scale: [0.8, 1.7] },
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
      { file: "grass-medium-02.glb", count: 22 },
      { file: "grass-bermuda-01.glb", count: 40 },
      { file: "nettle-plant.glb", count: 10 },
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
        const count = width < 640 ? 6 : 9;
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
    if (!reducedMotion) updateRain(delta);
    if (renderer && scene && camera) {
      if (!reducedMotion) {
        camera.position.x = parallax.x * 0.55;
        camera.position.y = 1.85 - parallax.y * 0.38;
        camera.lookAt(parallax.x * 0.15, 1.1 - parallax.y * 0.1, -12);
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
      if (composer) composer.render();
      else renderer.render(scene, camera);

      // Adaptive resolution: step the pixel ratio down when the GPU can't
      // hold ~45 fps, back up when it has headroom. 2 s windows keep it
      // from oscillating.
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
        } else if (fps < 30 && qualityIndex === PIXEL_STEPS.length - 1 && !bokehDisabled && composer) {
          // Last resort on very weak GPUs: drop the DOF pass entirely.
          // The fog + atmospheric perspective still carry the depth.
          bokehDisabled = true;
          composer.passes = composer.passes.filter(pass => !(pass instanceof BokehPass));
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
  initializeThreeScene();
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
    createRaindrops();
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
