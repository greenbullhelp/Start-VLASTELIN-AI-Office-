// VLASTELIN — 3D-офіс: панорамні вікна, нічне місто, планета, голографічне місто
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { fbm, noise3 } from './noise.js';

const CYAN = 0x3fb8ff, CYAN_L = 0x9fe6ff, GOLD = 0xe8b75a;

function rand(seed) { // детермінований генератор
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/* ---------- Процедурні текстури ---------- */
function canvasTex(w, h, draw, srgb = true) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function windowTexture(seed) {
  const r = rand(seed);
  return canvasTex(128, 256, (g, w, h) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
    const cols = 8, rows = 24, cw = w / cols, rh = h / rows;
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const v = r();
      if (v < 0.58) continue;
      g.fillStyle = v > 0.93 ? '#d8f0ff' : v > 0.6 ? '#ffcf7a' : '#ff9d4a';
      g.globalAlpha = 0.35 + r() * 0.65;
      g.fillRect(x * cw + 3, y * rh + 2, cw - 6, rh - 4);
    }
    g.globalAlpha = 1;
  });
}

function planetTextures() {
  const W = 1024, H = 512;
  const col = document.createElement('canvas'); col.width = W; col.height = H;
  const lit = document.createElement('canvas'); lit.width = W; lit.height = H;
  const bmp = document.createElement('canvas'); bmp.width = W; bmp.height = H;
  const cg = col.getContext('2d'), lg = lit.getContext('2d'), bg = bmp.getContext('2d');
  const ci = cg.createImageData(W, H), li = lg.createImageData(W, H), bi = bg.createImageData(W, H);
  const dots = [];
  const r = rand(7);
  for (let y = 0; y < H; y++) {
    const lat = (0.5 - y / H) * Math.PI, cl = Math.cos(lat), sl = Math.sin(lat);
    for (let x = 0; x < W; x++) {
      const lon = (x / W) * Math.PI * 2;
      const px = cl * Math.cos(lon), py = sl, pz = cl * Math.sin(lon);
      let h = fbm(px * 1.5 + 11, py * 1.5 + 3, pz * 1.5 + 7, 6);
      h += 0.12 * fbm(px * 6, py * 6, pz * 6, 3);
      const i = (y * W + x) * 4;
      const land = h > 0.035;
      const ice = Math.abs(lat) > 1.22 + 0.08 * noise3(px * 4, py * 4, pz * 4);
      let R, G, B;
      if (ice) { R = 215; G = 235; B = 250; }
      else if (land) {
        const e = Math.min(1, (h - 0.035) * 3.2);
        const d = 0.5 + 0.5 * fbm(px * 9, py * 9, pz * 9, 3);
        // реалістичний суходіл: ліси → степи/пустелі → гори
        const dry = .5 + .5 * fbm(px * 3 + 5, py * 3, pz * 3, 3) + Math.abs(lat) * -.25;
        const forest = [34, 72, 38], desert = [168, 140, 92], rock = [120, 112, 104];
        const mixC = (a, b, t) => a.map((v, k) => v + (b[k] - v) * t);
        let c3 = mixC(forest, desert, Math.max(0, Math.min(1, (dry - .45) * 3)));
        c3 = mixC(c3, rock, Math.max(0, Math.min(1, (e - .55) * 2.2)));
        const sh = .82 + d * .35;
        R = c3[0] * sh; G = c3[1] * sh; B = c3[2] * sh;
      } else {
        const s = Math.max(0, 1 + (h - 0.035) * 7);  // мілководдя біля берега
        R = 4 + s * 18; G = 22 + s * 60; B = 60 + s * 95;
      }
      ci.data[i] = R; ci.data[i + 1] = G; ci.data[i + 2] = B; ci.data[i + 3] = 255;
      const hb = land ? 120 + Math.min(1, (h - 0.035) * 3) * 135 : 40;
      bi.data[i] = bi.data[i + 1] = bi.data[i + 2] = hb; bi.data[i + 3] = 255;
      // вогні міст
      let L = 0;
      if (land && !ice) {
        const c = noise3(px * 22, py * 22, pz * 22);
        if (c > 0.22 && r() < 0.16) L = 150 + r() * 105;
        if (x % 6 === 0 && y % 6 === 0 && r() < 0.35) dots.push([lat, lon]);
      }
      li.data[i] = L; li.data[i + 1] = L * 0.82; li.data[i + 2] = L * 0.5; li.data[i + 3] = 255;
    }
  }
  cg.putImageData(ci, 0, 0); lg.putImageData(li, 0, 0); bg.putImageData(bi, 0, 0);
  const map = new THREE.CanvasTexture(col); map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 8;
  const lights = new THREE.CanvasTexture(lit); lights.colorSpace = THREE.SRGBColorSpace;
  const bump = new THREE.CanvasTexture(bmp);
  return { map, lights, bump, dots };
}

function cloudTexture() {
  const W = 512, H = 256;
  return canvasTex(W, H, (g) => {
    const img = g.createImageData(W, H);
    for (let y = 0; y < H; y++) {
      const lat = (0.5 - y / H) * Math.PI, cl = Math.cos(lat), sl = Math.sin(lat);
      for (let x = 0; x < W; x++) {
        const lon = (x / W) * Math.PI * 2;
        const v = fbm(cl * Math.cos(lon) * 4 + 40, sl * 4, cl * Math.sin(lon) * 4, 6);
        const a = Math.max(0, Math.min(1, (v - 0.12) * 4));
        const i = (y * W + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 255; img.data[i + 3] = a * 210;
      }
    }
    g.putImageData(img, 0, 0);
  }, false);
}

function platformTexture() {
  return canvasTex(1024, 1024, (g, w) => {
    const c = w / 2; g.translate(c, c);
    const ring = (r, lw, col, a = 1, dash = null) => {
      g.beginPath(); g.setLineDash(dash || []); g.lineWidth = lw; g.strokeStyle = col; g.globalAlpha = a;
      g.arc(0, 0, r, 0, Math.PI * 2); g.stroke();
    };
    const grd = g.createRadialGradient(0, 0, 0, 0, 0, c);
    grd.addColorStop(0, 'rgba(120,220,255,.55)'); grd.addColorStop(.45, 'rgba(30,120,220,.18)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd; g.fillRect(-c, -c, w, w);
    ring(500, 6, '#5fc8ff', .9); ring(470, 2, '#5fc8ff', .6, [18, 14]);
    ring(430, 10, '#e8b75a', .75, [120, 40, 20, 40]); ring(380, 2, '#9fe6ff', .7);
    ring(330, 4, '#5fc8ff', .8, [4, 10]); ring(250, 3, '#9fe6ff', .6); ring(160, 2, '#e8b75a', .7, [30, 16]);
    g.setLineDash([]); g.globalAlpha = .8; g.strokeStyle = '#9fe6ff'; g.lineWidth = 3;
    for (let i = 0; i < 120; i++) {
      const a = i / 120 * Math.PI * 2, l = i % 10 === 0 ? 40 : 16;
      g.beginPath(); g.moveTo(Math.cos(a) * 485, Math.sin(a) * 485);
      g.lineTo(Math.cos(a) * (485 - l), Math.sin(a) * (485 - l)); g.stroke();
    }
    g.globalAlpha = 1;
  });
}

function radialSprite(inner = 'rgba(160,230,255,1)', outer = 'rgba(0,0,0,0)') {
  return canvasTex(128, 128, (g, w) => {
    const grd = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    grd.addColorStop(0, inner); grd.addColorStop(1, outer);
    g.fillStyle = grd; g.fillRect(0, 0, w, w);
  });
}

/* ---------- Сцена ---------- */
export function initOffice(canvas, { stageEl, assistantEl } = {}) {
  const isMobile = matchMedia('(max-width: 900px)').matches;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !isMobile, powerPreference: 'high-performance' });
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = .92;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  let maxDpr = isMobile ? 1.5 : 2;
  renderer.setPixelRatio(Math.min(devicePixelRatio, maxDpr));

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x07152b, 0.0065);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 900);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  /* Небо */
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(600, 48, 24),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: {},
      vertexShader: `varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
      fragmentShader: `varying vec3 vP;
        void main(){
          float y = vP.y;
          vec3 top = vec3(.008,.016,.04), mid = vec3(.03,.07,.16), hor = vec3(.12,.2,.38), warm = vec3(.42,.24,.12);
          vec3 c = mix(mid, top, smoothstep(.05,.6,y));
          c = mix(hor, c, smoothstep(-.05,.18,y));
          c += warm * exp(-pow((y+.02)*14.,2.)) * .55;
          gl_FragColor = vec4(c,1.);
        }`
    })
  );
  scene.add(sky);

  /* Зірки */
  {
    const r = rand(3), n = 1400, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const th = r() * Math.PI * 2, ph = Math.acos(0.15 + r() * 0.85);
      pos.set([Math.sin(ph) * Math.cos(th) * 500, Math.cos(ph) * 500, Math.sin(ph) * Math.sin(th) * 500], i * 3);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xcfe9ff, size: 1.3, sizeAttenuation: false, fog: false, transparent: true, opacity: .8 })));
  }

  /* ===== Нічне місто за вікнами ===== */
  const CITY_Y = -34;
  const city = new THREE.Group(); scene.add(city);
  {
    const box = new THREE.BoxGeometry(1, 1, 1); box.translate(0, 0.5, 0);
    const mats = [11, 23, 37].map(seed => {
      const tex = windowTexture(seed); tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      const m = new THREE.MeshStandardMaterial({ color: 0x0b1526, roughness: .55, metalness: .5, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: .75 });
      m.onBeforeCompile = (sh) => {
        sh.vertexShader = sh.vertexShader.replace('#include <uv_vertex>', `#include <uv_vertex>
          #ifdef USE_INSTANCING
            vEmissiveMapUv *= vec2(length(instanceMatrix[0].xyz) * .22, length(instanceMatrix[1].xyz) * .09);
          #endif`);
      };
      return m;
    });
    const r = rand(42), per = 170;
    const dummy = new THREE.Object3D();
    mats.forEach((m, k) => {
      const im = new THREE.InstancedMesh(box, m, per);
      for (let i = 0; i < per; i++) {
        const a = (r() * 2 - 1) * 1.75;                 // кут від -100° до 100°
        const rad = 70 + Math.pow(r(), 1.2) * 190;
        const near = 1 - (rad - 70) / 190;
        const h = 14 + r() * 22 + (r() < .1 ? 26 : 0) + near * 4;
        const w = 4 + r() * 7;
        dummy.position.set(Math.sin(a) * rad, CITY_Y, -Math.cos(a) * rad);
        dummy.rotation.y = -a + (r() - .5) * .4;
        dummy.scale.set(w, h, 4 + r() * 7);
        dummy.updateMatrix(); im.setMatrixAt(i, dummy.matrix);
      }
      city.add(im);
    });

    // Скляні хмарочоси з контурним підсвіченням
    const edgeMat = new THREE.LineBasicMaterial({ color: CYAN, transparent: true, opacity: .55 });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x0d2240, metalness: .9, roughness: .15, envMap: envTex, envMapIntensity: .6 });
    [[-0.55, 90, 52, 9], [-0.25, 130, 64, 10], [0.66, 105, 48, 8], [-1.05, 95, 44, 9], [1.2, 120, 56, 11]].forEach(([a, rad, h, w]) => {
      const g = new THREE.BoxGeometry(w, h, w); g.translate(0, h / 2, 0);
      const m = new THREE.Mesh(g, glassMat);
      m.position.set(Math.sin(a) * rad, CITY_Y, -Math.cos(a) * rad); m.rotation.y = -a;
      const e = new THREE.LineSegments(new THREE.EdgesGeometry(g), edgeMat);
      m.add(e); city.add(m);
      const tip = new THREE.Mesh(new THREE.CylinderGeometry(.08, .25, 10, 6), new THREE.MeshBasicMaterial({ color: CYAN_L }));
      tip.position.y = h + 5; m.add(tip);
    });

    // Телевежа
    const tower = new THREE.Group();
    const towerMat = new THREE.MeshStandardMaterial({ color: 0x1a2a40, metalness: .6, roughness: .4, emissive: 0x0a1a30 });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 2.2, 120, 16), towerMat); shaft.position.y = 60; tower.add(shaft);
    const pod = new THREE.Mesh(new THREE.SphereGeometry(5, 24, 16), towerMat); pod.scale.y = .55; pod.position.y = 98; tower.add(pod);
    const podRing = new THREE.Mesh(new THREE.TorusGeometry(5.1, .25, 8, 48), new THREE.MeshBasicMaterial({ color: 0xffd27a }));
    podRing.rotation.x = Math.PI / 2; podRing.position.y = 98; tower.add(podRing);
    const ant = new THREE.Mesh(new THREE.CylinderGeometry(.25, .5, 30, 8), towerMat); ant.position.y = 117; tower.add(ant);
    const beacon = new THREE.Sprite(new THREE.SpriteMaterial({ map: radialSprite('rgba(255,90,100,1)'), color: 0xffffff, blending: THREE.AdditiveBlending, depthWrite: false }));
    beacon.scale.set(7, 7, 1); beacon.position.y = 133; tower.add(beacon);
    const ta = 0.4, tr = 150; tower.position.set(Math.sin(ta) * tr, CITY_Y, -Math.cos(ta) * tr);
    city.add(tower); city.userData.beacon = beacon;

    // Собор із двома баштами під теплим підсвіченням
    const church = new THREE.Group();
    const stone = new THREE.MeshStandardMaterial({ color: 0x5a3a22, roughness: .8, emissive: 0x4a2a12, emissiveIntensity: .9 });
    const copper = new THREE.MeshStandardMaterial({ color: 0x2f6b55, roughness: .5, metalness: .3, emissive: 0x153a2c, emissiveIntensity: .8 });
    const nave = new THREE.Mesh(new THREE.BoxGeometry(18, 22, 30), stone); nave.position.set(0, 11, 14); church.add(nave);
    const roof = new THREE.Mesh(new THREE.CylinderGeometry(0, 12, 10, 4, 1), stone); roof.rotation.y = Math.PI / 4; roof.scale.z = 2; roof.position.set(0, 27, 14); church.add(roof);
    [-5.5, 5.5].forEach(x => {
      const t = new THREE.Mesh(new THREE.BoxGeometry(8, 48, 8), stone); t.position.set(x, 24, 0); church.add(t);
      const d = new THREE.Mesh(new THREE.SphereGeometry(4.3, 20, 14, 0, Math.PI * 2, 0, Math.PI / 2), copper);
      d.scale.y = 1.5; d.position.set(x, 48, 0); church.add(d);
      const lt = new THREE.Mesh(new THREE.CylinderGeometry(.6, 1, 4, 8), copper); lt.position.set(x, 55, 0); church.add(lt);
    });
    const ca = 0.24, cr = 110; church.position.set(Math.sin(ca) * cr, CITY_Y, -Math.cos(ca) * cr); church.rotation.y = -ca + .3;
    city.add(church);
    const flood = new THREE.PointLight(0xffa860, 900, 80, 2); flood.position.set(Math.sin(ca) * (cr - 18), CITY_Y + 20, -Math.cos(ca) * (cr - 18)); city.add(flood);

    // Вуличні вогні внизу
    const n = 2600, pos = new Float32Array(n * 3), colA = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = (r() * 2 - 1) * 1.9, rad = 36 + r() * 260;
      pos.set([Math.sin(a) * rad, CITY_Y + .5, -Math.cos(a) * rad], i * 3);
      const warm = r() < .75; colA.set(warm ? [1, .72, .38] : [.6, .85, 1], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(colA, 3));
    city.add(new THREE.Points(g, new THREE.PointsMaterial({ size: 1.6, vertexColors: true, transparent: true, opacity: .9, blending: THREE.AdditiveBlending, depthWrite: false })));
    const ground = new THREE.Mesh(new THREE.CircleGeometry(400, 48), new THREE.MeshStandardMaterial({ color: 0x050a14, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2; ground.position.y = CITY_Y - .1; city.add(ground);
  }

  /* ===== Офіс: підлога, панорамні вікна, стеля ===== */
  const office = new THREE.Group(); scene.add(office);
  const R_WIN = 21, WIN_H = 17, A0 = -1.45, A1 = 1.45;
  const metal = new THREE.MeshStandardMaterial({ color: 0x141c28, metalness: .95, roughness: .3, envMap: envTex, envMapIntensity: .55 });
  const stripCyan = new THREE.MeshBasicMaterial({ color: CYAN_L });
  const stripGold = new THREE.MeshBasicMaterial({ color: 0xffc56e });
  {
    // глянцева підлога
    const floor = new THREE.Mesh(new THREE.CircleGeometry(R_WIN + 1, 96),
      new THREE.MeshStandardMaterial({ color: 0x060b14, metalness: .85, roughness: .22, envMap: envTex, envMapIntensity: .35 }));
    floor.rotation.x = -Math.PI / 2; office.add(floor);
    // світлові лінії в підлозі
    [6.5, 10, 14].forEach((r, i) => {
      const m = new THREE.Mesh(new THREE.RingGeometry(r, r + .05, 128, 1, Math.PI * .1, Math.PI * .8), i === 1 ? stripGold : stripCyan);
      m.rotation.x = -Math.PI / 2; m.position.y = .01; office.add(m);
    });

    // мульйони (вертикальні рами)
    const N = 15;
    for (let i = 0; i <= N; i++) {
      const a = A0 + (A1 - A0) * i / N;
      const g = new THREE.Group();
      const col = new THREE.Mesh(new THREE.BoxGeometry(.45, WIN_H, .7), metal); col.position.y = WIN_H / 2; g.add(col);
      const s = new THREE.Mesh(new THREE.BoxGeometry(.05, WIN_H - 1, .05), i % 3 === 0 ? stripGold : stripCyan);
      s.position.set(0, WIN_H / 2, .4); g.add(s);
      g.position.set(Math.sin(a) * R_WIN, 0, -Math.cos(a) * R_WIN); g.rotation.y = -a;
      office.add(g);
    }
    // підвіконня і верхня балка
    const arc = (r, y, tube, mat, rad = 1) => {
      const m = new THREE.Mesh(new THREE.TorusGeometry(r, tube, 8, 160, (A1 - A0) * rad), mat);
      m.rotation.x = Math.PI / 2; m.rotation.z = -Math.PI / 2 + A0 * rad; m.position.y = y; office.add(m); return m;
    };
    arc(R_WIN, .55, .55, metal); arc(R_WIN - .45, 1.05, .04, stripCyan);
    arc(R_WIN, WIN_H, .7, metal); arc(R_WIN - .6, WIN_H - .7, .05, stripCyan);
    arc(R_WIN - .2, 6.2, .07, metal); // тонкий горизонтальний імпост

    // скло з ледь помітним відблиском
    const glass = new THREE.Mesh(
      new THREE.CylinderGeometry(R_WIN - .1, R_WIN - .1, WIN_H, 96, 1, true, Math.PI - A1, A1 - A0),
      new THREE.MeshPhysicalMaterial({ color: 0x4d8cff, metalness: 0, roughness: .05, transparent: true, opacity: .07, envMap: envTex, envMapIntensity: .25, side: THREE.DoubleSide, depthWrite: false }));
    glass.position.y = WIN_H / 2; office.add(glass);

    // стеля з кільцями світла, як у макеті
    const ceil = new THREE.Mesh(new THREE.CircleGeometry(R_WIN + 1, 64), new THREE.MeshStandardMaterial({ color: 0x070c16, metalness: .7, roughness: .5, side: THREE.DoubleSide }));
    ceil.rotation.x = Math.PI / 2; ceil.position.y = WIN_H + .6; office.add(ceil);
    [[5, CYAN_L, .08], [7.5, 0xffc56e, .06], [11, CYAN_L, .07], [15, CYAN_L, .05]].forEach(([r, c, t]) => {
      const m = new THREE.Mesh(new THREE.TorusGeometry(r, t, 8, 128), new THREE.MeshBasicMaterial({ color: c }));
      m.rotation.x = Math.PI / 2; m.position.y = WIN_H + .4; office.add(m);
    });
    // кільцеві балки стелі
    for (let i = 0; i < 12; i++) {
      const a = i / 12 * Math.PI * 2;
      const b = new THREE.Mesh(new THREE.BoxGeometry(.35, .5, R_WIN - 5), metal);
      b.position.set(Math.sin(a) * (R_WIN / 2 + 2.5), WIN_H + .2, -Math.cos(a) * (R_WIN / 2 + 2.5)); b.rotation.y = -a;
      office.add(b);
    }
  }

  /* ===== Голографічна платформа ===== */
  const holo = new THREE.Group(); scene.add(holo);
  const PLAT_R = 3.6, PLAT_Y = .5;
  const platTex = platformTexture();
  {
    const base = new THREE.Mesh(new THREE.CylinderGeometry(PLAT_R, PLAT_R + .4, PLAT_Y, 96), metal);
    base.position.y = PLAT_Y / 2; holo.add(base);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(PLAT_R + .05, .05, 8, 160), stripGold);
    rim.rotation.x = Math.PI / 2; rim.position.y = PLAT_Y; holo.add(rim);
    const rim2 = new THREE.Mesh(new THREE.TorusGeometry(PLAT_R + .42, .035, 8, 160), stripCyan);
    rim2.rotation.x = Math.PI / 2; rim2.position.y = .05; holo.add(rim2);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(PLAT_R, 96),
      new THREE.MeshBasicMaterial({ map: platTex, transparent: true, opacity: .75, blending: THREE.AdditiveBlending, depthWrite: false }));
    disc.rotation.x = -Math.PI / 2; disc.position.y = PLAT_Y + .01; holo.add(disc); holo.userData.disc = disc;
    // світло на підлозі довкола
    const halo = new THREE.Mesh(new THREE.CircleGeometry(9, 64),
      new THREE.MeshBasicMaterial({ map: radialSprite('rgba(80,180,255,.28)'), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    halo.rotation.x = -Math.PI / 2; halo.position.y = .02; holo.add(halo);
  }

  // Об'ємне голографічне місто
  {
    const r = rand(99), n = 150;
    const dummy = new THREE.Object3D();
    const box = new THREE.BoxGeometry(1, 1, 1); box.translate(0, .5, 0);
    const fill = new THREE.InstancedMesh(box, new THREE.MeshBasicMaterial({ color: 0x2aa8ff, transparent: true, opacity: .1, blending: THREE.AdditiveBlending, depthWrite: false }), n);
    const edges = [], winPts = [];
    const E = [[0,0,0,1,0,0],[1,0,0,1,0,1],[1,0,1,0,0,1],[0,0,1,0,0,0],[0,1,0,1,1,0],[1,1,0,1,1,1],[1,1,1,0,1,1],[0,1,1,0,1,0],[0,0,0,0,1,0],[1,0,0,1,1,0],[1,0,1,1,1,1],[0,0,1,0,1,1]];
    let k = 0;
    for (let i = 0; i < n * 3 && k < n; i++) {
      const rr = Math.sqrt(r()) * (PLAT_R - .6), a = r() * Math.PI * 2;
      const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
      const w = .14 + r() * .2, d = .14 + r() * .2;
      const center = Math.exp(-(rr * rr) / 2.2);
      const h = .2 + center * (1.4 + r() * 1.4) + r() * .35;
      dummy.position.set(x, PLAT_Y, z); dummy.scale.set(w, h, d); dummy.rotation.y = 0; dummy.updateMatrix();
      fill.setMatrixAt(k++, dummy.matrix);
      const x0 = x - w / 2, z0 = z - d / 2, y0 = PLAT_Y;
      E.forEach(e => edges.push(x0 + e[0] * w, y0 + e[1] * h, z0 + e[2] * d, x0 + e[3] * w, y0 + e[4] * h, z0 + e[5] * d));
      const floors = Math.floor(h / .09);
      for (let f = 1; f < floors; f++) if (r() < .5) {
        const side = r() < .5;
        winPts.push(side ? x0 + r() * w : x0 + (r() < .5 ? 0 : w), y0 + f * .09, side ? z0 + (r() < .5 ? 0 : d) : z0 + r() * d);
      }
    }
    fill.count = k; holo.add(fill);
    // головна вежа зі шпилем
    const spireH = 3.4;
    const sp = new THREE.Mesh(new THREE.CylinderGeometry(.02, .22, spireH, 6), new THREE.MeshBasicMaterial({ color: CYAN_L, transparent: true, opacity: .55, blending: THREE.AdditiveBlending }));
    sp.position.y = PLAT_Y + spireH / 2; holo.add(sp);
    const eg = new THREE.BufferGeometry(); eg.setAttribute('position', new THREE.Float32BufferAttribute(edges, 3));
    holo.add(new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: CYAN_L, transparent: true, opacity: .5, blending: THREE.AdditiveBlending, depthWrite: false })));
    const wg = new THREE.BufferGeometry(); wg.setAttribute('position', new THREE.Float32BufferAttribute(winPts, 3));
    const wm = new THREE.PointsMaterial({ color: 0xcff4ff, size: .035, transparent: true, opacity: .9, blending: THREE.AdditiveBlending, depthWrite: false });
    holo.add(new THREE.Points(wg, wm)); holo.userData.winMat = wm;
  }

  /* ===== Планета ===== */
  const GLOBE_Y = 6.4, GR = 2.5;
  const globe = new THREE.Group(); globe.position.y = GLOBE_Y; scene.add(globe);
  const tex = planetTextures();
  const earth = new THREE.Mesh(new THREE.SphereGeometry(GR, 128, 64),
    new THREE.MeshStandardMaterial({ map: tex.map, bumpMap: tex.bump, bumpScale: .9, roughness: .62, metalness: .05, emissive: 0xffffff, emissiveMap: tex.lights, emissiveIntensity: 1.1 }));
  const sunDirView = { value: new THREE.Vector3(-1, .6, 1).normalize() };
  earth.material.onBeforeCompile = (sh) => {
    sh.uniforms.uSunDir = sunDirView;
    sh.fragmentShader = 'uniform vec3 uSunDir;\n' + sh.fragmentShader.replace('#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
       totalEmissiveRadiance *= smoothstep(.25, -.3, dot(normal, uSunDir));`);
  };
  earth.rotation.z = .41; globe.add(earth);
  const clouds = new THREE.Mesh(new THREE.SphereGeometry(GR * 1.012, 96, 48),
    new THREE.MeshStandardMaterial({ map: cloudTexture(), transparent: true, opacity: .5, depthWrite: false, roughness: 1 }));
  clouds.rotation.z = .41; globe.add(clouds);
  // атмосфера
  const atmo = new THREE.Mesh(new THREE.SphereGeometry(GR * 1.2, 64, 32), new THREE.ShaderMaterial({
    side: THREE.BackSide, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    vertexShader: `varying vec3 vN; varying vec3 vV; void main(){ vec4 mv = modelViewMatrix*vec4(position,1.); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }`,
    fragmentShader: `varying vec3 vN; varying vec3 vV; void main(){ float f = pow(1. - abs(dot(vN, vV)), 2.); gl_FragColor = vec4(vec3(.25,.6,1.) * f * .9, f); }`
  }));
  globe.add(atmo);
  const rimGlow = new THREE.Mesh(new THREE.SphereGeometry(GR * 1.015, 64, 32), new THREE.ShaderMaterial({
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    vertexShader: `varying vec3 vN; varying vec3 vV; void main(){ vec4 mv = modelViewMatrix*vec4(position,1.); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }`,
    fragmentShader: `varying vec3 vN; varying vec3 vV; void main(){ float f = pow(1. - max(0., dot(vN, vV)), 3.); gl_FragColor = vec4(vec3(.35,.75,1.) * f * .8, f); }`
  }));
  globe.add(rimGlow);
  // голографічна сітка і точки над континентами
  const gridPts = [], gR = GR * 1.035;
  for (let la = -75; la <= 75; la += 15) {           // паралелі
    const y = Math.sin(la * Math.PI / 180) * gR, rr = Math.cos(la * Math.PI / 180) * gR;
    for (let i = 0; i < 96; i++) { const a0 = i / 96 * Math.PI * 2, a1 = (i + 1) / 96 * Math.PI * 2; gridPts.push(Math.cos(a0) * rr, y, Math.sin(a0) * rr, Math.cos(a1) * rr, y, Math.sin(a1) * rr); }
  }
  for (let lo = 0; lo < 180; lo += 15) {             // меридіани
    const c = Math.cos(lo * Math.PI / 180), sn = Math.sin(lo * Math.PI / 180);
    for (let i = 0; i < 96; i++) {
      const a0 = i / 96 * Math.PI * 2, a1 = (i + 1) / 96 * Math.PI * 2;
      gridPts.push(Math.cos(a0) * gR * c, Math.sin(a0) * gR, Math.cos(a0) * gR * sn, Math.cos(a1) * gR * c, Math.sin(a1) * gR, Math.cos(a1) * gR * sn);
    }
  }
  const gridG = new THREE.BufferGeometry(); gridG.setAttribute('position', new THREE.Float32BufferAttribute(gridPts, 3));
  const grid = new THREE.LineSegments(gridG, new THREE.LineBasicMaterial({ color: CYAN, transparent: true, opacity: .1, blending: THREE.AdditiveBlending, depthWrite: false }));
  grid.rotation.z = .41; globe.add(grid);
  {
    const pts = new Float32Array(tex.dots.length * 3);
    tex.dots.forEach(([lat, lon], i) => {
      const rr = GR * 1.025;
      pts.set([Math.cos(lat) * Math.cos(lon) * rr, Math.sin(lat) * rr, Math.cos(lat) * Math.sin(lon) * rr], i * 3);
    });
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pts, 3));
    const dots = new THREE.Points(g, new THREE.PointsMaterial({ color: CYAN_L, size: .022, transparent: true, opacity: .35, blending: THREE.AdditiveBlending, depthWrite: false }));
    dots.rotation.z = .41; globe.add(dots); globe.userData.dots = dots;
  }
  // орбіти, супутники і пиловий пояс
  const orbits = new THREE.Group(); globe.add(orbits);
  const mkOrbit = (r, tube, color, tiltX, tiltZ) => {
    const o = new THREE.Group(); o.rotation.set(tiltX, 0, tiltZ);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r, tube, 8, 256), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .85, blending: THREE.AdditiveBlending, depthWrite: false }));
    ring.rotation.x = Math.PI / 2; o.add(ring);
    const sat = new THREE.Mesh(new THREE.SphereGeometry(.09, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffe0a0 }));
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: radialSprite('rgba(255,215,140,1)'), blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.scale.set(.7, .7, 1); sat.add(glow); o.add(sat);
    o.userData = { r, sat, speed: .25 + Math.random() * .2, phase: Math.random() * 6 };
    orbits.add(o); return o;
  };
  mkOrbit(GR * 1.55, .018, CYAN_L, .32, -.28);
  mkOrbit(GR * 1.78, .012, 0xffc56e, -.2, .22);
  {
    const r = rand(5), n = 2200, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2, rr = GR * (1.32 + r() * .14);
      pos.set([Math.cos(a) * rr, (r() - .5) * .05, Math.sin(a) * rr], i * 3);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const belt = new THREE.Points(g, new THREE.PointsMaterial({ color: 0x8fdcff, size: .02, transparent: true, opacity: .7, blending: THREE.AdditiveBlending, depthWrite: false }));
    belt.rotation.set(.32, 0, -.28); orbits.add(belt); orbits.userData.belt = belt;
  }

  /* ===== Світловий промінь від платформи до планети ===== */
  const beamH = GLOBE_Y - GR * .85 - PLAT_Y;
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(GR * .55, PLAT_R * .78, beamH, 64, 1, true), new THREE.ShaderMaterial({
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    uniforms: { uTime: { value: 0 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
    fragmentShader: `uniform float uTime; varying vec2 vUv;
      void main(){
        float a = pow(1. - vUv.y, 1.8) * .2;
        float scan = .75 + .25 * sin(vUv.y * 60. - uTime * 4.);
        float streak = .6 + .4 * sin(vUv.x * 80. + uTime * .7);
        gl_FragColor = vec4(vec3(.35,.8,1.) * a * scan * streak, a);
      }`
  }));
  beam.position.y = PLAT_Y + beamH / 2; scene.add(beam);
  // частинки, що піднімаються
  const rising = (() => {
    const r = rand(77), n = 260, pos = new Float32Array(n * 3), spd = new Float32Array(n);
    for (let i = 0; i < n; i++) { const a = r() * 6.28, rr = r() * 1.9; pos.set([Math.cos(a) * rr, PLAT_Y + r() * beamH, Math.sin(a) * rr], i * 3); spd[i] = .3 + r() * .9; }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const p = new THREE.Points(g, new THREE.PointsMaterial({ color: CYAN_L, size: .045, transparent: true, opacity: .8, blending: THREE.AdditiveBlending, depthWrite: false }));
    p.userData.spd = spd; scene.add(p); return p;
  })();

  /* ===== Світло ===== */
  scene.add(new THREE.AmbientLight(0x3a5a9a, .35));
  scene.add(new THREE.HemisphereLight(0x3a6ab0, 0x0a0f1a, .45));
  const sun = new THREE.DirectionalLight(0xdfefff, 2.2); sun.position.set(-8, 7, 9); scene.add(sun);
  const platLight = new THREE.PointLight(CYAN, 30, 22, 2); platLight.position.set(0, 1.6, 0); scene.add(platLight);
  const goldLight = new THREE.PointLight(GOLD, 35, 26, 2); goldLight.position.set(6, WIN_H - 2, -6); scene.add(goldLight);

  /* ===== Постобробка ===== */
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), .62, .5, .82);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  /* ===== Камера і розмір ===== */
  const target = new THREE.Vector3(0, 4.6, 0);
  const camBase = new THREE.Vector3(0, 5.4, 21);
  const pointer = { x: 0, y: 0, sx: 0, sy: 0 };
  function resize() {
    const w = innerWidth, h = innerHeight;
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    bloom.resolution.set(w / 2, h / 2);
    camera.aspect = w / h;
    const portrait = w / h < 1;
    camera.fov = portrait ? 58 : 40;
    camBase.set(0, portrait ? 5.8 : 5.4, portrait ? 23 : 21);
    // центруємо сцену під вільною частиною головної зони
    camera.clearViewOffset();
    if (stageEl) {
      const sr = stageEl.getBoundingClientRect();
      let cx = sr.left + sr.width / 2;
      const ar = assistantEl && assistantEl.getBoundingClientRect();
      if (!portrait && ar && ar.width && ar.top < sr.bottom && ar.right < sr.right - 200) cx = (ar.right + sr.right) / 2;
      const cy = sr.top + scrollY + sr.height * .5;
      camera.setViewOffset(w, h, -(cx - w / 2), -(cy - h / 2) * (portrait ? 1 : .6), w, h);
    }
    camera.updateProjectionMatrix();
  }
  addEventListener('resize', resize);
  addEventListener('pointermove', e => { pointer.x = e.clientX / innerWidth * 2 - 1; pointer.y = e.clientY / innerHeight * 2 - 1; });
  resize();

  /* ===== Анімація ===== */
  const clock = new THREE.Clock();
  let eco = false, running = true;
  function frame() {
    if (!running) return;
    requestAnimationFrame(frame);
    if (document.hidden) return;
    const dt = Math.min(clock.getDelta(), .05), t = clock.elapsedTime;
    const sp = eco ? .35 : 1;
    earth.rotation.y += dt * .06 * sp;
    clouds.rotation.y += dt * .075 * sp;
    grid.rotation.y = earth.rotation.y; globe.userData.dots.rotation.y = earth.rotation.y;
    orbits.children.forEach(o => {
      if (!o.userData.sat) return;
      const a = o.userData.phase + t * o.userData.speed * sp;
      o.userData.sat.position.set(Math.cos(a) * o.userData.r, 0, Math.sin(a) * o.userData.r);
    });
    orbits.userData.belt.rotation.y += dt * .05 * sp;
    holo.userData.disc.rotation.z += dt * .08 * sp;
    holo.userData.winMat.opacity = .65 + .3 * Math.sin(t * 2.3);
    beam.material.uniforms.uTime.value = t;
    const pa = rising.geometry.attributes.position, spd = rising.userData.spd;
    for (let i = 0; i < spd.length; i++) {
      let y = pa.getY(i) + dt * spd[i] * sp;
      if (y > PLAT_Y + beamH) y = PLAT_Y;
      pa.setY(i, y);
    }
    pa.needsUpdate = true;
    city.userData.beacon.material.opacity = (Math.sin(t * 3) > 0 ? 1 : .15);
    // м'який паралакс
    pointer.sx += (pointer.x - pointer.sx) * .04; pointer.sy += (pointer.y - pointer.sy) * .04;
    camera.position.set(camBase.x + pointer.sx * 1.2 + Math.sin(t * .1) * .4, camBase.y - pointer.sy * .6, camBase.z);
    camera.lookAt(target);
    camera.updateMatrixWorld();
    sunDirView.value.copy(sun.position).normalize().transformDirection(camera.matrixWorldInverse);
    if (eco) renderer.render(scene, camera); else composer.render();
  }
  frame();

  return {
    setEco(v) {
      eco = v;
      renderer.setPixelRatio(Math.min(devicePixelRatio, v ? 1 : maxDpr));
      resize();
    },
    resize,
    stop() { running = false; }
  };
}
