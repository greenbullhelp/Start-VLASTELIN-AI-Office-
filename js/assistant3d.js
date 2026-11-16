// VLASTELIN — оригінальний сріблястий AI-андроїд (хромовий бюст із сяючими лініями)
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const g2 = (x, y, cx, cy, sx, sy) => Math.exp(-(((x - cx) / sx) ** 2 + ((y - cy) / sy) ** 2));

// Форма голови: деформуємо сферу (обличчя дивиться в +Z)
function sculpt(v) {
  const { x, y, z } = v;
  const front = Math.max(0, z);
  let sx = .8, sy = 1.15, sz = .95;
  if (y < 0) { const t = -y; sx *= 1 - .27 * t * t; sz *= 1 - .1 * t; }
  if (y > .3) { sz *= 1 + .08 * (y - .3); sx *= 1 + .03 * (y - .3); }
  if (z < -.2) sz *= 1.04;
  let d = 0;
  d += .075 * g2(x, y, 0, .3, .5, .07) * front;                       // надбрівна дуга
  d -= .11 * (g2(x, y, .29, .14, .13, .075) + g2(x, y, -.29, .14, .13, .075)) * front; // очниці
  d += .2 * Math.exp(-((x / .065) ** 2)) * g2(0, y, 0, -.08, 1, .2) * front;          // спинка носа
  d += .06 * (g2(x, y, .085, -.2, .045, .04) + g2(x, y, -.085, -.2, .045, .04)) * front; // крила носа
  d += .06 * (g2(x, y, .44, -.04, .14, .13) + g2(x, y, -.44, -.04, .14, .13)) * front;   // вилиці
  d -= .05 * (g2(x, y, .38, -.3, .12, .14) + g2(x, y, -.38, -.3, .12, .14)) * front;     // западини щік
  d += .035 * g2(x, y, 0, -.37, .17, .035) * front;                   // верхня губа
  d -= .03 * g2(x, y, 0, -.425, .2, .015) * front;                    // лінія рота
  d += .04 * g2(x, y, 0, -.48, .15, .04) * front;                     // нижня губа
  d += .08 * g2(x, y, 0, -.78, .2, .1) * front;                       // підборіддя
  d += .04 * (g2(x, y, .5, -.62, .2, .12) + g2(x, y, -.5, -.62, .2, .12)) * Math.max(0, z + .3); // лінія щелепи
  d -= .045 * (g2(x, y, .66, .22, .12, .18) + g2(x, y, -.66, .22, .12, .18));                   // скроні
  return new THREE.Vector3(x * sx, y * sy, z * sz).addScaledVector(v, d);
}

function headGeometry() {
  const g = new THREE.SphereGeometry(1, 192, 160);
  const p = g.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).normalize();
    const s = sculpt(v);
    p.setXYZ(i, s.x, s.y, s.z);
  }
  g.computeVertexNormals();
  return g;
}

// Лінія по поверхні голови (для сяючих «схем»)
function surfaceTube(dirs, offset, radius) {
  const pts = dirs.map(d => {
    const v = new THREE.Vector3(...d).normalize();
    return sculpt(v).addScaledVector(v, offset);
  });
  const curve = new THREE.CatmullRomCurve3(pts);
  return new THREE.TubeGeometry(curve, 96, radius, 8, false);
}

function glowSprite(color) {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'), grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, color); grd.addColorStop(.25, color.replace(/[\d.]+\)$/, '.45)')); grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Sprite(new THREE.SpriteMaterial({ map: t, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false }));
}

export function initAssistant(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(26, 1, .1, 50);
  camera.position.set(0, -.6, 8.1);
  camera.lookAt(0, -.75, 0);

  // Середовище для хромових відблисків: студія + синя і золота світлові панелі
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = new RoomEnvironment();
  const panel = (color, intensity, pos, scale) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity) }));
    m.position.set(...pos); m.scale.set(...scale); env.add(m);
  };
  panel(0x2a9dff, 6, [-6, 2, -3], [1, 10, 6]);
  panel(0x2a9dff, 4, [0, -6, -4], [12, .5, 4]);
  panel(0xffb347, 4, [6, 3, -2], [1, 8, 4]);
  panel(0xffffff, 2.2, [-1, 2.5, 6], [7, 3, .5]);   // м'який софтбокс спереду
  panel(0xcfe6ff, 1.2, [0, 6, 0], [8, .5, 8]);
  scene.environment = pmrem.fromScene(env, .02).texture;

  const chrome = new THREE.MeshPhysicalMaterial({ color: 0xdfe7f0, metalness: 1, roughness: .16, clearcoat: 1, clearcoatRoughness: .08, envMapIntensity: 1.25 });
  const darkSeam = new THREE.MeshStandardMaterial({ color: 0x0c1420, metalness: .8, roughness: .4 });
  const glowCyan = new THREE.MeshBasicMaterial({ color: 0x8fe4ff });
  const glowGold = new THREE.MeshBasicMaterial({ color: 0xffc870 });

  const bust = new THREE.Group(); scene.add(bust);
  const head = new THREE.Group(); bust.add(head);
  head.add(new THREE.Mesh(headGeometry(), chrome));

  // Очі
  const eyes = [];
  [-1, 1].forEach(s => {
    const dir = new THREE.Vector3(.29 * s, .14, .95).normalize();
    const p = sculpt(dir);
    const eye = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), new THREE.MeshBasicMaterial({ color: 0xbff2ff }));
    eye.scale.set(.085, .03, .03); eye.position.copy(p).addScaledVector(dir, -.005);
    eye.rotation.z = s * -.12;
    head.add(eye);
    const glow = glowSprite('rgba(120,220,255,1)'); glow.scale.set(.55, .3, 1); glow.position.copy(p).addScaledVector(dir, .04);
    head.add(glow);
    eyes.push({ eye, glow });
  });

  // Сяючі «схеми» на скронях і центральний шов
  [-1, 1].forEach(s => {
    head.add(new THREE.Mesh(surfaceTube([[.55 * s, .32, .75], [.78 * s, .2, .35], [.92 * s, .05, -.05], [.8 * s, -.25, -.4], [.55 * s, -.55, -.55]], .004, .009), glowCyan));
    head.add(new THREE.Mesh(surfaceTube([[.7 * s, .45, .45], [.85 * s, .4, .05], [.75 * s, .5, -.4]], .004, .006), glowCyan));
    // «вушні» вузли
    const node = new THREE.Group();
    const dir = new THREE.Vector3(1 * s, .02, -.05).normalize(), p = sculpt(dir);
    node.position.copy(p); node.lookAt(p.clone().add(dir));
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(.13, .15, .05, 32), chrome); disc.rotation.x = Math.PI / 2; node.add(disc);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(.1, .012, 8, 48), glowCyan); ring.position.z = .03; node.add(ring);
    const core = new THREE.Mesh(new THREE.CircleGeometry(.045, 24), glowGold); core.position.z = .031; node.add(core);
    head.add(node);
  });
  head.add(new THREE.Mesh(surfaceTube([[0, .55, .83], [0, .95, .3], [0, .9, -.45], [0, .4, -.9]], .002, .006), darkSeam));

  // Шия, трапеція і плечі — єдиний плавний силует (lathe), сплющений спереду-назад
  const body = new THREE.Group(); body.scale.z = .58; bust.add(body);
  const prof = [[.001, -3.4], [1.9, -3.4], [2.0, -2.95], [1.92, -2.5], [1.6, -2.22], [1.05, -2.02], [.66, -1.86],
    [.5, -1.62], [.46, -1.35], [.43, -1.05], [.38, -.85], [.001, -.8]].map(([r, y]) => new THREE.Vector2(r, y));
  const bodyG = new THREE.LatheGeometry(new THREE.SplineCurve(prof).getPoints(80), 128);
  body.add(new THREE.Mesh(bodyG, chrome));
  [-1.22, -1.45, -1.68].forEach((y, i) => {
    const r = [.445, .47, .52][i] + .006;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r, .009, 8, 96), i === 1 ? glowCyan : darkSeam);
    ring.rotation.x = Math.PI / 2; ring.position.y = y; body.add(ring);
  });
  // ключиці та нагрудна пластина (у локальних координатах тіла, на поверхні)
  [-1, 1].forEach(sg => {
    const pts = [[.15, -2.0, 1.0], [.6, -2.02, 1.05], [1.0, -2.12, 1.3], [1.35, -2.25, 1.68]].map(([x, y, r]) =>
      new THREE.Vector3(x * sg, y, Math.sqrt(Math.max(0, r * r - x * x)) + .015));
    body.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 40, .014, 8, false), glowCyan));
  });
  const plate = new THREE.Mesh(new THREE.CircleGeometry(.16, 6), glowGold);
  plate.position.set(0, -2.45, 1.82); body.add(plate);
  const plateRing = new THREE.Mesh(new THREE.TorusGeometry(.25, .016, 6, 6), glowCyan);
  plateRing.position.copy(plate.position); body.add(plateRing);

  // Світло
  scene.add(new THREE.AmbientLight(0x6688aa, .2));
  const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(-3, 3, 5); scene.add(key);
  const rimB = new THREE.PointLight(0x3fb8ff, 40, 12, 2); rimB.position.set(-3, 1, -2.5); scene.add(rimB);
  const rimG = new THREE.PointLight(0xffb347, 22, 12, 2); rimG.position.set(3, .5, -2); scene.add(rimG);
  const under = new THREE.PointLight(0x3fb8ff, 10, 8, 2); under.position.set(0, -2.2, 3); scene.add(under);

  function resize() {
    const r = canvas.getBoundingClientRect();
    if (!r.width) return;
    renderer.setSize(r.width, r.height, false);
    camera.aspect = r.width / r.height; camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(canvas); resize();

  const ptr = { x: 0, y: 0, sx: 0, sy: 0 };
  addEventListener('pointermove', e => { ptr.x = e.clientX / innerWidth * 2 - 1; ptr.y = e.clientY / innerHeight * 2 - 1; });

  let speaking = 0, listening = false, eco = false;
  const clock = new THREE.Clock();
  (function loop() {
    requestAnimationFrame(loop);
    if (document.hidden) return;
    const t = clock.getElapsedTime();
    ptr.sx += (ptr.x - ptr.sx) * .05; ptr.sy += (ptr.y - ptr.sy) * .05;
    const sp = eco ? .4 : 1;
    head.rotation.y = Math.sin(t * .35 * sp) * .22 + ptr.sx * .35;
    head.rotation.x = Math.sin(t * .27 * sp) * .04 + ptr.sy * .12 - .03;
    bust.rotation.y = head.rotation.y * .25;
    bust.position.y = Math.sin(t * .8 * sp) * .03;
    speaking = Math.max(0, speaking - .012);
    const pulse = listening ? .75 + .25 * Math.sin(t * 9) : .85 + .15 * Math.sin(t * 2) + speaking * .6 * Math.abs(Math.sin(t * 14));
    eyes.forEach(({ eye, glow }) => {
      glow.material.opacity = Math.min(1, pulse);
      eye.material.color.setHSL(listening ? .12 : .54, .9, .72 + .1 * pulse);
      glow.material.color.setHSL(listening ? .1 : .55, 1, .65);
    });
    renderer.render(scene, camera);
  })();

  return {
    speak() { speaking = 1; },
    listen(v) { listening = v; },
    setEco(v) { eco = v; renderer.setPixelRatio(Math.min(devicePixelRatio, v ? 1 : 2)); resize(); }
  };
}
