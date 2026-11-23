(() => {
  const shell = document.getElementById("authShell");
  const sceneCanvas = document.getElementById("loginScene");
  const fieldCanvas = document.getElementById("asciiField");
  const farmCanvas = document.getElementById("farmScene");
  const glassCanvas = document.getElementById("glassPane");
  const sceneTelemetry = document.getElementById("sceneTelemetry");
  const fieldStatus = document.getElementById("fieldStatus");
  if (!shell || !sceneCanvas || !fieldCanvas || !farmCanvas || !glassCanvas) return;

  const field = fieldCanvas.getContext("2d");
  const farm = farmCanvas.getContext("2d");
  const glass = glassCanvas.getContext("2d");
  if (!field) {
    console.error("[login-scene] Could not initialize the ASCII field canvas.");
    return;
  }
  if (!farm || !glass) {
    console.error("[login-scene] Could not initialize the farm or glass canvas.");
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
  let farmPlants = [];
  let farmTexture = null;
  let raindrops = [];
  let frame = 0;
  let running = false;
  let resizeObserver = null;
  let lastFarmDraw = 0;
  let lastGlassDraw = 0;
  let cropShaderUniforms = null;
  let glassShaderUniforms = null;

  const random = (min, max) => min + Math.random() * (max - min);
  const randomInt = max => Math.floor(Math.random() * max);
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

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

  function createEnvironmentMap() {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 256;
    const context = canvas.getContext("2d");
    const sky = context.createLinearGradient(0, 0, 0, canvas.height);
    sky.addColorStop(0, "#8c9d91");
    sky.addColorStop(0.42, "#c2c7af");
    sky.addColorStop(0.5, "#a9ac8c");
    sky.addColorStop(0.58, "#617354");
    sky.addColorStop(1, "#18291d");
    context.fillStyle = sky;
    context.fillRect(0, 0, canvas.width, canvas.height);

    const sun = context.createRadialGradient(356, 80, 2, 356, 80, 82);
    sun.addColorStop(0, "rgba(255, 247, 215, 0.9)");
    sun.addColorStop(0.12, "rgba(250, 241, 209, 0.42)");
    sun.addColorStop(1, "rgba(250, 241, 209, 0)");
    context.fillStyle = sun;
    context.fillRect(270, 0, 172, 164);

    for (const [x, y, w, h, opacity] of [
      [54, 42, 34, 88, 0.2],
      [196, 24, 21, 112, 0.13],
      [446, 34, 29, 96, 0.17],
    ]) {
      const softbox = context.createLinearGradient(x, y, x + w, y + h);
      softbox.addColorStop(0, "rgba(249, 253, 245, 0)");
      softbox.addColorStop(0.5, `rgba(249, 253, 245, ${opacity})`);
      softbox.addColorStop(1, "rgba(249, 253, 245, 0)");
      context.fillStyle = softbox;
      context.fillRect(x - 12, y - 6, w + 24, h + 12);
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.mapping = THREE.EquirectangularReflectionMapping;
    texture.encoding = THREE.sRGBEncoding;
    texture.needsUpdate = true;
    return texture;
  }

  function addPaperShader(material, seed) {
    const uniforms = { uPaperSeed: { value: seed } };
    material.onBeforeCompile = shader => {
      shader.uniforms.uPaperSeed = uniforms.uPaperSeed;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec2 vCiaoPaperUv;")
        .replace("#include <uv_vertex>", "#include <uv_vertex>\nvCiaoPaperUv = uv;");
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
          varying vec2 vCiaoPaperUv;
          uniform float uPaperSeed;
          float ciaoPaperHash(vec2 p) {
            return fract(sin(dot(p, vec2(127.1, 311.7)) + uPaperSeed * 74.7) * 43758.5453);
          }`
        )
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>
          float ciaoPaperGrain = ciaoPaperHash(floor(vCiaoPaperUv * vec2(1200.0, 850.0)));
          float ciaoPaperFiber = sin(vCiaoPaperUv.x * 1850.0 + sin(vCiaoPaperUv.y * 410.0 + uPaperSeed) * 1.6);
          diffuseColor.rgb *= 1.0 + (ciaoPaperGrain - 0.5) * 0.065 + ciaoPaperFiber * 0.009;`
        )
        .replace(
          "#include <roughnessmap_fragment>",
          `#include <roughnessmap_fragment>
          roughnessFactor = clamp(roughnessFactor + ciaoPaperGrain * 0.035, 0.0, 1.0);`
        );
    };
    material.customProgramCacheKey = () => "ciaochat-paper-fiber-v1";
  }

  function addGlassShader(material) {
    const uniforms = { uCiaoGlassTime: { value: 0 } };
    material.onBeforeCompile = shader => {
      shader.uniforms.uCiaoGlassTime = uniforms.uCiaoGlassTime;
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          "#include <common>\n#ifndef USE_UV\nattribute vec2 uv;\n#endif\nvarying vec2 vCiaoGlassUv;"
        )
        .replace("#include <uv_vertex>", "#include <uv_vertex>\nvCiaoGlassUv = uv;");
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
          varying vec2 vCiaoGlassUv;
          uniform float uCiaoGlassTime;
          float ciaoGlassHash(vec2 p) {
            return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
          }
          float ciaoGlassDrops(vec2 uv) {
            vec2 grid = vec2(uv.x * 17.0, fract(uv.y + uCiaoGlassTime * 0.003) * 8.0);
            vec2 cell = floor(grid);
            vec2 dropLocal = fract(grid) - 0.5;
            float seed = ciaoGlassHash(cell);
            float radius = mix(0.075, 0.28, ciaoGlassHash(cell + 19.7));
            dropLocal.x *= 0.78;
            float drop = 1.0 - smoothstep(radius * 0.68, radius, length(dropLocal));
            return drop * step(0.42, seed);
          }`
        )
        .replace(
          "#include <normal_fragment_begin>",
          `#include <normal_fragment_begin>
          float ciaoGlassDropNormal = ciaoGlassDrops(vCiaoGlassUv);
          normal = normalize(normal + vec3(
            sin(vCiaoGlassUv.x * 83.0 + uCiaoGlassTime) * ciaoGlassDropNormal * 0.025,
            cos(vCiaoGlassUv.y * 57.0 - uCiaoGlassTime) * ciaoGlassDropNormal * 0.025,
            0.0
          ));`
        )
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>
          float ciaoGlassDropColor = ciaoGlassDrops(vCiaoGlassUv);
          diffuseColor.rgb += vec3(0.035, 0.05, 0.038) * ciaoGlassDropColor;`
        )
        .replace(
          "#include <roughnessmap_fragment>",
          `#include <roughnessmap_fragment>
          roughnessFactor = mix(roughnessFactor, 0.025, ciaoGlassDrops(vCiaoGlassUv) * 0.88);`
        );
    };
    material.customProgramCacheKey = () => "ciaochat-rain-glass-v1";
    return uniforms;
  }

  function resizeField() {
    const bounds = shell.getBoundingClientRect();
    width = Math.max(1, bounds.width);
    height = Math.max(1, bounds.height);
    pixelRatio = Math.min(window.devicePixelRatio || 1, 1.4);
    for (const canvas of [farmCanvas, sceneCanvas, glassCanvas, fieldCanvas]) {
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    field.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    farm.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    glass.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    createFarmPlants();
    createRaindrops();
    if (renderer) {
      resizeScene();
      if (reducedMotionQuery.matches || document.body.classList.contains("reduced-motion")) {
        updateCropLayer(0);
        if (cropShaderUniforms) cropShaderUniforms.uCropTime.value = 0;
        if (glassShaderUniforms) glassShaderUniforms.uCiaoGlassTime.value = 0;
        renderer.render(scene, camera);
      }
    }
    drawFarm(performance.now(), true);
    drawGlass(performance.now(), 0, true);
  }

  function createFarmPlants() {
    const count = Math.min(850, Math.round(width * height / 1450));
    farmPlants = Array.from({ length: count }, () => ({
      x: random(0, 1),
      depth: random(0, 1),
      height: random(0.55, 1.35),
      phase: random(0, Math.PI * 2),
      tone: randomInt(4),
    }));
    const textureCanvas = document.createElement("canvas");
    textureCanvas.width = 256;
    textureCanvas.height = 256;
    const textureContext = textureCanvas.getContext("2d");
    for (let i = 0; i < 5200; i++) {
      const shade = randomInt(2) ? "210, 218, 172" : "22, 38, 21";
      textureContext.fillStyle = `rgba(${shade}, ${random(0.025, 0.11)})`;
      textureContext.fillRect(random(0, 256), random(0, 256), random(0.4, 1.8), random(0.4, 1.4));
    }
    farmTexture = farm.createPattern(textureCanvas, "repeat");
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

  function drawFarm(now, force = false) {
    if (!force && now - lastFarmDraw < 32) return;
    lastFarmDraw = now;
    const breeze = reducedMotionQuery.matches || document.body.classList.contains("reduced-motion") ? 0 : now * 0.001;
    const horizon = height * 0.43;

    farm.clearRect(0, 0, width, height);
    const sky = farm.createLinearGradient(0, 0, 0, horizon * 1.15);
    sky.addColorStop(0, "#526b70");
    sky.addColorStop(0.52, "#94a895");
    sky.addColorStop(1, "#c2c0a1");
    farm.fillStyle = sky;
    farm.fillRect(0, 0, width, horizon * 1.2);

    const sun = farm.createRadialGradient(width * 0.72, horizon * 0.36, 2, width * 0.72, horizon * 0.36, width * 0.3);
    sun.addColorStop(0, "rgba(241, 238, 205, 0.26)");
    sun.addColorStop(1, "rgba(241, 238, 205, 0)");
    farm.fillStyle = sun;
    farm.fillRect(0, 0, width, horizon * 1.2);

    farm.save();
    farm.translate(parallax.x * 2.2, parallax.y * 1.1);
    farm.filter = "blur(10px)";
    for (let cloud = 0; cloud < 7; cloud++) {
      const x = width * (0.08 + cloud * 0.16);
      const y = horizon * (0.12 + (cloud % 3) * 0.11);
      farm.fillStyle = "rgba(235, 239, 222, " + (0.025 + (cloud % 2) * 0.018) + ")";
      farm.beginPath();
      farm.ellipse(x, y, width * 0.095, horizon * 0.055, 0, 0, Math.PI * 2);
      farm.fill();
    }
    farm.filter = "none";

    for (let ridge = 0; ridge < 3; ridge++) {
      const y = horizon * (0.77 + ridge * 0.095);
      farm.beginPath();
      farm.moveTo(0, y + horizon * 0.07);
      farm.bezierCurveTo(width * 0.22, y - horizon * 0.17, width * 0.37, y + horizon * 0.13, width * 0.58, y - horizon * 0.015);
      farm.bezierCurveTo(width * 0.76, y - horizon * 0.13, width * 0.88, y + horizon * 0.08, width, y - horizon * 0.055);
      farm.lineTo(width, height);
      farm.lineTo(0, height);
      farm.closePath();
      farm.fillStyle = ["#667d60", "#536e4b", "#435c3e"][ridge];
      farm.fill();
    }
    farm.restore();

    const field = farm.createLinearGradient(0, horizon, 0, height);
    field.addColorStop(0, "#6e8053");
    field.addColorStop(0.34, "#49613b");
    field.addColorStop(1, "#172b1c");
    farm.fillStyle = field;
    farm.fillRect(0, horizon, width, height - horizon);
    if (farmTexture) {
      farm.globalAlpha = 0.34;
      farm.fillStyle = farmTexture;
      farm.fillRect(0, horizon, width, height - horizon);
      farm.globalAlpha = 1;
    }

    farm.save();
    farm.translate(parallax.x * 5, parallax.y * 2.5);
    const vanishingX = width * (0.49 + parallax.x * 0.002);
    const vanishingY = horizon * 1.04;
    for (let row = -15; row <= 15; row++) {
      const bottomX = vanishingX + row * width * 0.064;
      farm.beginPath();
      farm.moveTo(vanishingX + row * 1.2, vanishingY);
      farm.bezierCurveTo(
        vanishingX + row * width * 0.018,
        horizon + (height - horizon) * 0.28,
        bottomX - row * width * 0.02,
        height * 0.79,
        bottomX,
        height + 12
      );
      farm.strokeStyle = row % 2
        ? "rgba(177, 182, 121, 0.18)"
        : "rgba(20, 42, 24, 0.2)";
      farm.lineWidth = Math.max(1, width * 0.0012);
      farm.stroke();
    }

    const haze = farm.createLinearGradient(0, horizon * 0.9, 0, horizon * 1.7);
    haze.addColorStop(0, "rgba(212, 214, 188, 0.35)");
    haze.addColorStop(1, "rgba(212, 214, 188, 0)");
    farm.fillStyle = haze;
    farm.fillRect(0, horizon * 0.9, width, horizon * 0.8);

    for (const plant of farmPlants) {
      const y = horizon + Math.pow(plant.depth, 1.65) * (height - horizon);
      const depth = (y - horizon) / Math.max(1, height - horizon);
      const x = plant.x * width + parallax.x * (2 + depth * 8);
      const stemHeight = (4 + depth * 29) * plant.height;
      const sway = Math.sin(breeze * 1.45 + plant.phase + depth * 3) * (1.5 + depth * 5);
      const stemWidth = 0.7 + depth * 1.4;
      const greens = ["#667b43", "#82914f", "#596f3d", "#9a9b59"];
      farm.strokeStyle = greens[plant.tone];
      farm.lineWidth = stemWidth;
      farm.beginPath();
      farm.moveTo(x, y);
      farm.quadraticCurveTo(x + sway * 0.35, y - stemHeight * 0.56, x + sway, y - stemHeight);
      farm.stroke();
      farm.lineWidth = Math.max(0.55, stemWidth * 0.58);
      for (const side of [-1, 1]) {
        farm.beginPath();
        farm.moveTo(x + sway * 0.45, y - stemHeight * 0.42);
        farm.quadraticCurveTo(
          x + side * stemHeight * 0.2 + sway,
          y - stemHeight * 0.53,
          x + side * stemHeight * 0.31 + sway,
          y - stemHeight * 0.66
        );
        farm.stroke();
      }
    }
    farm.restore();

    const vignette = farm.createRadialGradient(width * 0.5, height * 0.52, height * 0.18, width * 0.5, height * 0.52, height * 0.88);
    vignette.addColorStop(0, "rgba(8, 15, 10, 0)");
    vignette.addColorStop(1, "rgba(5, 11, 7, 0.38)");
    farm.fillStyle = vignette;
    farm.fillRect(0, 0, width, height);
    if (farmSceneTexture) farmSceneTexture.needsUpdate = true;
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

  let renderer = null;
  let scene = null;
  let camera = null;
  let bills = [];
  let cropMesh = null;
  let cropInstances = [];
  let cropDummy = null;
  let viewHeight = 0;
  let shadowMaterial = null;
  let farmSceneTexture = null;
  let farmPlane = null;
  let glassMesh = null;

  function makeBillTexture(index) {
    const canvas = document.createElement("canvas");
    canvas.width = 768;
    canvas.height = 432;
    const ctx = canvas.getContext("2d");
    const gradient = ctx.createLinearGradient(0, 0, 768, 432);
    gradient.addColorStop(0, "#a9c49b");
    gradient.addColorStop(0.45, "#799c6f");
    gradient.addColorStop(1, "#526f4d");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 768, 432);

    const seeded = (n => () => {
      n = (n * 1664525 + 1013904223) >>> 0;
      return n / 4294967296;
    })(index + 89);
    for (let i = 0; i < 18000; i++) {
      const shade = seeded() > 0.5 ? 255 : 0;
      ctx.fillStyle = `rgba(${shade},${shade},${shade},${seeded() * 0.035})`;
      ctx.fillRect(seeded() * 768, seeded() * 432, 1.4, 1.4);
    }
    for (let i = 0; i < 520; i++) {
      const x = seeded() * 768;
      const y = seeded() * 432;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.quadraticCurveTo(x + seeded() * 5, y + seeded() * 3, x + seeded() * 11, y + seeded() * 5);
      ctx.strokeStyle = seeded() > 0.5 ? "rgba(248, 255, 236, 0.16)" : "rgba(36, 68, 38, 0.12)";
      ctx.lineWidth = 0.45 + seeded() * 0.45;
      ctx.stroke();
    }

    ctx.strokeStyle = "rgba(231, 244, 220, 0.82)";
    ctx.lineWidth = 3;
    ctx.strokeRect(16, 16, 736, 400);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(26, 57, 34, 0.74)";
    ctx.strokeRect(25, 25, 718, 382);

    ctx.save();
    ctx.beginPath();
    ctx.rect(34, 34, 700, 364);
    ctx.clip();
    for (let y = 40; y < 400; y += 6) {
      ctx.beginPath();
      for (let x = 35; x <= 733; x += 3) {
        const wave = Math.sin((x + index * 73) * 0.034 + y * 0.018) * 6;
        if (x === 35) ctx.moveTo(x, y + wave);
        else ctx.lineTo(x, y + wave);
      }
      ctx.strokeStyle = `rgba(26, 59, 35, ${0.13 + (y % 4) * 0.025})`;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.restore();

    for (const x of [104, 664]) {
      ctx.beginPath();
      ctx.ellipse(x, 216, 58, 112, 0, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(31, 65, 38, 0.72)";
      ctx.lineWidth = 2;
      ctx.stroke();
      for (let ring = 0; ring < 6; ring++) {
        ctx.beginPath();
        ctx.ellipse(x, 216, 35 + ring * 3.5, 76 + ring * 5, 0, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(228, 242, 217, ${0.4 - ring * 0.035})`;
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
    }

    ctx.strokeStyle = "rgba(28, 63, 37, 0.75)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(384, 218, 112, 132, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(384, 218, 101, 121, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "rgba(20, 50, 29, 0.22)";
    ctx.beginPath();
    ctx.ellipse(384, 218, 92, 112, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#183b25";
    ctx.font = "700 22px Georgia, serif";
    ctx.textAlign = "left";
    ctx.fillText("CIAOCHAT", 50, 75);
    ctx.font = "12px Georgia, serif";
    ctx.fillText("DIGITAL COMMUNITY CREDIT", 50, 96);
    ctx.textAlign = "right";
    ctx.font = "700 21px Georgia, serif";
    ctx.fillText("100", 718, 75);
    ctx.font = "12px Georgia, serif";
    ctx.fillText("SERIES 01", 718, 96);
    ctx.textAlign = "center";
    ctx.font = "700 102px Georgia, serif";
    ctx.fillText("C", 384, 253);
    ctx.font = "700 24px Georgia, serif";
    ctx.fillText("ONE HUNDRED", 384, 310);
    ctx.font = "10px ui-monospace, monospace";
    ctx.fillText("C C C  010101  C C C  010101  C C C", 384, 340);
    ctx.fillText("SERIES C  /  2026  /  CIAOCHAT EXCHANGE", 384, 366);
    ctx.textAlign = "left";
    for (let i = 0; i < 9; i++) {
      const y = 126 + i * 18;
      ctx.fillStyle = `rgba(25, 55, 33, ${0.42 + (i % 3) * 0.1})`;
      ctx.fillRect(53, y, 116 + (i % 4) * 11, 1.3);
      ctx.fillRect(598, y, 116 - (i % 4) * 9, 1.3);
    }
    ctx.fillStyle = "rgba(246, 255, 236, 0.22)";
    ctx.fillRect(33, 34, 702, 4);

    const texture = new THREE.CanvasTexture(canvas);
    texture.encoding = THREE.sRGBEncoding;
    texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    texture.needsUpdate = true;
    return texture;
  }

  function createBill(index) {
    const geometry = new THREE.PlaneGeometry(3.4, 1.92, 24, 12);
    const position = geometry.attributes.position;
    const basePositions = new Float32Array(position.array);
    const material = new THREE.MeshPhysicalMaterial({
      map: makeBillTexture(index),
      roughness: 0.76,
      metalness: 0.005,
      transmission: 0.065,
      thickness: 0.14,
      clearcoat: 0.14,
      clearcoatRoughness: 0.78,
      envMapIntensity: 0.72,
      side: THREE.DoubleSide,
    });
    addPaperShader(material, index + 1);
    const paper = new THREE.Mesh(geometry, material);
    paper.position.z = 0.016;
    paper.castShadow = true;
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(3.9, 2.4), shadowMaterial);
    shadow.position.set(0.06, -0.08, -0.022);
    const edge = new THREE.Mesh(
      new THREE.BoxGeometry(3.4, 1.92, 0.024),
      new THREE.MeshStandardMaterial({ color: 0x3f5840, roughness: 0.94 })
    );
    const mesh = new THREE.Group();
    mesh.add(shadow, edge, paper);
    const scale = random(0.58, 1.04);
    mesh.scale.setScalar(scale);
    const z = random(-16, 2.4);
    const halfHeight = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * (camera.position.z - z);
    mesh.position.set(
      random(-halfHeight * camera.aspect * 0.84, halfHeight * camera.aspect * 0.84),
      random(-halfHeight * 0.58, halfHeight * 0.5),
      z
    );
    scene.add(mesh);
    return {
      mesh,
      geometry,
      position,
      basePositions,
      phase: random(0, Math.PI * 2),
      velocityY: random(0.25, 0.8),
      velocityX: random(-0.2, 0.2),
      gravity: random(0.7, 1.25),
      lift: random(0.08, 0.24),
      drag: random(0.035, 0.095),
      terminalVelocity: random(2.6, 4.1),
      angularX: random(-0.45, 0.45),
      angularY: random(-0.7, 0.7),
      angularZ: random(-0.42, 0.42),
      scale,
    };
  }

  function createCropLayer() {
    const vertices = [
      0, 0, 0, -0.13, 0.12, 0, -0.19, 0.92, 0.05,
      0, 0, 0, 0.13, 0.12, 0, 0.09, 0.78, 0.04,
      0, 0, 0, -0.08, 0.2, 0, 0.025, 1.12, 0.08,
      0, 0, 0, 0.08, 0.2, 0, 0.19, 0.98, 0.07,
      0, 0, 0, -0.035, 0.1, 0, -0.04, 0.73, 0.03,
    ];
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
    geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.88,
      envMapIntensity: 0.42,
      side: THREE.DoubleSide,
    });
    cropShaderUniforms = { uCropTime: { value: 0 } };
    material.onBeforeCompile = shader => {
      shader.uniforms.uCropTime = cropShaderUniforms.uCropTime;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nuniform float uCropTime;")
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
          float ciaoCropWind = sin(uCropTime * 1.35 + position.y * 2.8 + instanceMatrix[3].x * 0.34);
          transformed.x += ciaoCropWind * 0.06 * position.y;
          transformed.z += cos(uCropTime * 1.08 + position.y * 2.2 + instanceMatrix[3].x * 0.27) * 0.025 * position.y;`
        );
    };
    material.customProgramCacheKey = () => "ciaochat-crop-wind-v1";
    const count = Math.min(520, Math.max(240, Math.round(width / 2.4)));
    cropMesh = new THREE.InstancedMesh(geometry, material, count);
    cropMesh.castShadow = true;
    cropMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    cropDummy = new THREE.Object3D();
    cropInstances = Array.from({ length: count }, () => {
      const depth = random(0, 1);
      const z = -7 - depth * 17;
      const instance = {
        xRatio: random(-1.08, 1.08),
        bottom: random(0.25, 4.8),
        z,
        scale: (0.32 + depth * 0.72) * random(0.7, 1.25),
        phase: random(0, Math.PI * 2),
        depth,
      };
      return instance;
    });
    const tangent = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    for (let i = 0; i < cropInstances.length; i++) {
      const crop = cropInstances[i];
      const distance = camera.position.z - crop.z;
      const halfHeight = tangent * distance;
      cropDummy.position.set(crop.xRatio * halfHeight * camera.aspect, -halfHeight + crop.bottom, crop.z);
      cropDummy.scale.setScalar(crop.scale);
      cropDummy.updateMatrix();
      cropMesh.setMatrixAt(i, cropDummy.matrix);
      cropMesh.setColorAt(i, new THREE.Color().setHSL(0.23 + random(-0.025, 0.025), 0.3 + random(0, 0.22), 0.2 + crop.depth * 0.18));
    }
    cropMesh.instanceMatrix.needsUpdate = true;
    if (cropMesh.instanceColor) cropMesh.instanceColor.needsUpdate = true;
    scene.add(cropMesh);
  }

  function updateCropLayer(seconds) {
    if (!cropMesh || !cropDummy) return;
    const tangent = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    for (let i = 0; i < cropInstances.length; i++) {
      const crop = cropInstances[i];
      const distance = camera.position.z - crop.z;
      const halfHeight = tangent * distance;
      cropDummy.position.set(
        crop.xRatio * halfHeight * camera.aspect + parallax.x * 0.16,
        -halfHeight + crop.bottom + parallax.y * 0.08,
        crop.z
      );
      cropDummy.rotation.z = Math.sin(seconds * 1.25 + crop.phase) * 0.075;
      cropDummy.scale.setScalar(crop.scale);
      cropDummy.updateMatrix();
      cropMesh.setMatrixAt(i, cropDummy.matrix);
    }
    cropMesh.instanceMatrix.needsUpdate = true;
  }

  function resizeScene() {
    if (!renderer || !camera) return;
    const bounds = shell.getBoundingClientRect();
    const aspect = Math.max(0.4, bounds.width / Math.max(1, bounds.height));
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.4));
    renderer.setSize(bounds.width, bounds.height, false);
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    camera.lookAt(0, 0, 0);
    viewHeight = 2 * camera.position.z * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    if (farmPlane) {
      const fieldDistance = camera.position.z - farmPlane.position.z;
      const fieldHeight = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * fieldDistance;
      farmPlane.scale.set(fieldHeight * aspect * 1.16, fieldHeight * 1.16, 1);
    }
    if (glassMesh) {
      const glassDistance = camera.position.z - glassMesh.position.z;
      const glassHeight = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * glassDistance;
      glassMesh.scale.set(glassHeight * aspect * 1.12, glassHeight * 1.12, 1);
    }
    for (const bill of bills) {
      const halfHeight = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * (camera.position.z - bill.mesh.position.z);
      bill.mesh.position.x = THREE.MathUtils.clamp(bill.mesh.position.x, -halfHeight * aspect * 0.9, halfHeight * aspect * 0.9);
    }
  }

  function initializeThreeScene() {
    if (!window.THREE) {
      console.error("[login-scene] Three.js did not load; the animated banknotes are unavailable.");
      return;
    }
    try {
      renderer = new THREE.WebGLRenderer({
        canvas: sceneCanvas,
        antialias: true,
        alpha: true,
        powerPreference: "low-power",
      });
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.physicallyCorrectLights = true;
      renderer.setClearColor(0x07100a, 0);
      renderer.outputEncoding = THREE.sRGBEncoding;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.12;

      scene = new THREE.Scene();
      scene.background = null;
      scene.environment = createEnvironmentMap();
      scene.fog = new THREE.FogExp2(0x07100a, 0.018);
      camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
      camera.position.z = 18;

      scene.add(new THREE.HemisphereLight(0xcbd8c9, 0x273529, 0.82));
      scene.add(new THREE.AmbientLight(0xb7d4b8, 0.46));
      const keyLight = new THREE.DirectionalLight(0xf0ffed, 2.7);
      keyLight.position.set(-5, 8, 12);
      keyLight.castShadow = true;
      keyLight.shadow.mapSize.set(1024, 1024);
      keyLight.shadow.camera.left = -24;
      keyLight.shadow.camera.right = 24;
      keyLight.shadow.camera.top = 18;
      keyLight.shadow.camera.bottom = -18;
      keyLight.shadow.camera.near = 0.1;
      keyLight.shadow.camera.far = 90;
      keyLight.shadow.bias = -0.0002;
      keyLight.shadow.radius = 3;
      scene.add(keyLight);
      const rimLight = new THREE.DirectionalLight(0xdce9ce, 1.15);
      rimLight.position.set(7, 4, -10);
      scene.add(rimLight);
      const greenFill = new THREE.PointLight(0x8caa7a, 2.2, 28);
      greenFill.position.set(6, -2, 5);
      scene.add(greenFill);

      farmSceneTexture = new THREE.CanvasTexture(farmCanvas);
      farmSceneTexture.encoding = THREE.sRGBEncoding;
      farmSceneTexture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
      farmPlane = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshStandardMaterial({ map: farmSceneTexture, roughness: 0.92, metalness: 0, fog: false })
      );
      farmPlane.position.z = -34;
      farmPlane.receiveShadow = true;
      scene.add(farmPlane);

      const glassMaterial = new THREE.MeshPhysicalMaterial({
        color: 0xe7f3e8,
        roughness: 0.1,
        metalness: 0,
        transmission: 0.24,
        thickness: 0.12,
        ior: 1.33,
        clearcoat: 1,
        clearcoatRoughness: 0.04,
        envMapIntensity: 1.05,
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      glassShaderUniforms = addGlassShader(glassMaterial);
      glassMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), glassMaterial);
      glassMesh.position.z = 3;
      scene.add(glassMesh);

      createCropLayer();

      const shadowCanvas = document.createElement("canvas");
      shadowCanvas.width = 128;
      shadowCanvas.height = 128;
      const shadowContext = shadowCanvas.getContext("2d");
      const shadowGradient = shadowContext.createRadialGradient(64, 64, 8, 64, 64, 62);
      shadowGradient.addColorStop(0, "rgba(0, 0, 0, 0.28)");
      shadowGradient.addColorStop(0.5, "rgba(0, 0, 0, 0.12)");
      shadowGradient.addColorStop(1, "rgba(0, 0, 0, 0)");
      shadowContext.fillStyle = shadowGradient;
      shadowContext.fillRect(0, 0, 128, 128);
      const shadowTexture = new THREE.CanvasTexture(shadowCanvas);
      shadowMaterial = new THREE.MeshBasicMaterial({
        map: shadowTexture,
        transparent: true,
        opacity: 0.42,
        depthWrite: false,
      });

      resizeScene();
      const count = width < 640 ? 6 : 9;
      bills = Array.from({ length: count }, (_, index) => createBill(index));
      resizeScene();
      return true;
    } catch (error) {
      renderer = null;
      console.error("[login-scene] Could not initialize the 3D banknote scene.", error);
      return false;
    }
  }

  function animate(now) {
    if (!running || authShellHidden()) return;
    const delta = Math.min(0.04, Math.max(0, (now - (animate.lastTime || now)) / 1000));
    const seconds = now / 1000;
    const reducedMotion = reducedMotionQuery.matches || document.body.classList.contains("reduced-motion");
    animate.lastTime = now;
    if (cropShaderUniforms) cropShaderUniforms.uCropTime.value = reducedMotion ? 0 : seconds;
    if (glassShaderUniforms) glassShaderUniforms.uCiaoGlassTime.value = reducedMotion ? 0 : seconds;
    if (!reducedMotion) {
      parallax.x += (parallaxTarget.x - parallax.x) * Math.min(1, delta * 2.4);
      parallax.y += (parallaxTarget.y - parallax.y) * Math.min(1, delta * 2.4);
    }
    drawFarm(now);
    drawGlass(now, delta);
    drawField(now);
    if (renderer) {
      if (!reducedMotion) {
        camera.position.x = parallax.x * 0.62;
        camera.position.y = -parallax.y * 0.42;
        camera.lookAt(parallax.x * 0.17, parallax.y * 0.12, 0);
      }
      for (const bill of bills) {
        const { mesh, geometry, position, basePositions, phase } = bill;
        if (!reducedMotion) {
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
        for (let vertex = 0; vertex < position.count; vertex++) {
          const x = basePositions[vertex * 3];
          const y = basePositions[vertex * 3 + 1];
          const edge = Math.abs(x) / 1.7;
          const ripple = Math.sin(x * 1.65 + seconds * 3.2 + phase) * 0.075;
          const curl = Math.pow(edge, 2.4) * Math.sin(y * 2.4 + seconds * 2.4 + phase) * 0.11;
          position.array[vertex * 3 + 2] = ripple + curl;
        }
        position.needsUpdate = true;
        geometry.computeVertexNormals();
      }
      if (!reducedMotion) updateCropLayer(seconds);
      renderer.render(scene, camera);
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
    drawFarm(now, true);
    drawGlass(now, 0, true);
    drawField(now);
    updateCropLayer(0);
    if (cropShaderUniforms) cropShaderUniforms.uCropTime.value = 0;
    if (glassShaderUniforms) glassShaderUniforms.uCiaoGlassTime.value = 0;
    if (renderer) renderer.render(scene, camera);
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
})();
