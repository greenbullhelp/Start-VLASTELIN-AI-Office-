// VLASTELIN — оригінальний хромовий AI-андроїд «Аргентум»
// Детальна скульптура голови і торса, дзеркальний хром із відбиттям неба, жива анімація.
import * as THREE from 'three';

const g2 = (x, y, cx, cy, sx, sy) => Math.exp(-(((x - cx) / sx) ** 2 + ((y - cy) / sy) ** 2));
const smooth = (e0, e1, x) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
// гаусова «гряда» вздовж відрізка (у площині XY)
function segG(x, y, ax, ay, bx, by, w) {
  const vx = bx - ax, vy = by - ay, t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy)));
  const dx = x - (ax + vx * t), dy = y - (ay + vy * t);
  return Math.exp(-(dx * dx + dy * dy) / (w * w));
}

/* ================= ГОЛОВА ================= */
// v — точка на одиничній сфері (обличчя дивиться в +Z)
function sculpt(v) {
  const { x, y, z } = v;
  const f = smooth(-.05, .45, z);          // «фронтальність»
  const ax = Math.abs(x);
  let sx = .82, sy = 1.08, sz = .97;
  if (y < 0) { const t = -y; sx *= 1 - .16 * t * t; sz *= 1 - .06 * t; }   // звуження до підборіддя
  if (y > .25) { sz *= 1 + .1 * (y - .25); }                            // череп
  if (z < -.3) sz *= 1.05;                                               // потилиця
  let d = 0;
  // лоб і надбрівні дуги
  d += .05 * g2(x, y, 0, .55, .45, .2) * f;
  d += .085 * (g2(x, y, .24, .29, .2, .055) + g2(x, y, -.24, .29, .2, .055)) * f;
  d -= .03 * g2(x, y, 0, .33, .05, .05) * f;                            // перенісся між бровами
  // очниці, повіки, вилиці
  d -= .075 * (g2(x, y, .27, .15, .12, .065) + g2(x, y, -.27, .15, .12, .065)) * f;
  d += .025 * (g2(x, y, .27, .2, .11, .022) + g2(x, y, -.27, .2, .11, .022)) * f;
  d += .015 * (g2(x, y, .28, .085, .1, .02) + g2(x, y, -.28, .085, .1, .02)) * f;
  d += .075 * (g2(x, y, .45, -.02, .13, .1) + g2(x, y, -.45, -.02, .13, .1)) * f;
  d -= .06 * (g2(x, y, .4, -.28, .12, .14) + g2(x, y, -.4, -.28, .12, .14)) * f;
  // ніс: спинка, кінчик, крила, ніздрі
  d += .2 * Math.exp(-((x / .06) ** 2)) * g2(0, y, 0, -.02, 1, .22) * f;
  d += .07 * g2(x, y, 0, -.2, .07, .05) * f;
  d += .055 * (g2(x, y, .09, -.215, .045, .04) + g2(x, y, -.09, -.215, .045, .04)) * f;
  d -= .03 * (g2(x, y, .045, -.255, .025, .015) + g2(x, y, -.045, -.255, .025, .015)) * f;
  // носогубні складки
  d -= .03 * (segG(x, y, .13, -.22, .24, -.42, .025) + segG(x, y, -.13, -.22, -.24, -.42, .025)) * f;
  // губи: фільтрум, верхня/нижня губа, лінія і кутики рота
  d -= .012 * g2(x, y, 0, -.3, .025, .03) * f;
  d += .04 * g2(x, y, 0, -.35, .15, .03) * f;
  d -= .035 * g2(x, y, 0, -.385, .17, .011) * f;
  d += .045 * g2(x, y, 0, -.42, .13, .035) * f;
  d -= .02 * (g2(x, y, .17, -.385, .025, .025) + g2(x, y, -.17, -.385, .025, .025)) * f;
  d -= .025 * g2(x, y, 0, -.5, .14, .025) * f;
  // підборіддя і щелепа
  d += .085 * g2(x, y, 0, -.66, .19, .1) * f;
  d += .06 * (segG(x, y, .52, -.38, .2, -.72, .07) + segG(x, y, -.52, -.38, -.2, -.72, .07)) * smooth(-.4, .2, z);
  d += .04 * g2(ax, y, .58, -.42, .08, .09);
  // скроні
  d -= .045 * g2(ax, y, .7, .22, .12, .18);
  return new THREE.Vector3(x * sx, y * sy, z * sz).addScaledVector(v, d);
}

function headGeometry() {
  const g = new THREE.SphereGeometry(1, 256, 200);
  const p = g.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i).normalize(); const s = sculpt(v); p.setXYZ(i, s.x, s.y, s.z); }
  g.computeVertexNormals();
  return g;
}

function surfaceTube(dirs, offset, radius) {
  const pts = dirs.map(d => { const v = new THREE.Vector3(...d).normalize(); return sculpt(v).addScaledVector(v, offset); });
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 120, radius, 8, false);
}

/* ================= ТОРС ================= */
function bodyGeometry() {
  const prof = [[.001, -5.6], [2.05, -5.6], [2.12, -4.6], [2.22, -3.5], [2.25, -2.95], [2.1, -2.5], [1.6, -2.18], [1.05, -2.02], [.66, -1.88],
    [.52, -1.6], [.49, -1.3], [.46, -1.05], [.37, -.84], [.001, -.8]].map(([r, y]) => new THREE.Vector2(r, y));
  const g = new THREE.LatheGeometry(new THREE.SplineCurve(prof).getPoints(140), 220, Math.PI);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {   // груди сплющені спереду-назад, шия майже кругла
    const y = p.getY(i), k = .92 - .32 * smooth(-1.75, -2.35, y);
    p.setZ(i, p.getZ(i) * k);
  }
  g.computeVertexNormals();
  const n = g.attributes.normal.clone();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), ax = Math.abs(x);
    const front = smooth(-.05, .35, z), back = smooth(.05, -.35, z);
    let d = 0;
    d += .07 * segG(ax, y, .38, -1.02, .1, -1.95, .085) * smooth(-.2, .2, z);  // м'язи шиї
    d -= .06 * g2(x, y, 0, -1.98, .13, .09) * front;                           // яремна ямка
    d += .05 * segG(ax, y, .14, -2.0, 1.35, -2.18, .065) * front;              // ключиці
    d -= .025 * segG(ax, y, .2, -2.12, 1.25, -2.32, .06) * front;
    d += .1 * g2(ax, y, .95, -1.95, .45, .2) * smooth(.5, -.2, z);             // трапеція
    d += .2 * g2(ax, y, 1.95, -2.5, .38, .42);                                 // дельти
    d -= .04 * segG(ax, y, 1.45, -2.25, 1.62, -3.0, .07) * front;              // борозна дельта/груди
    d += .2 * g2(ax, y, .8, -2.8, .6, .38) * front;                            // грудні м'язи
    d -= .09 * segG(ax, y, .15, -3.25, 1.35, -3.12, .08) * front;              // нижній край грудних
    d -= .07 * Math.exp(-((x / .1) ** 2)) * g2(0, y, 0, -2.75, 1, .55) * front;  // грудина
    d += .03 * (g2(ax, y, .38, -3.65, .22, .16) + g2(ax, y, .38, -4.05, .22, .16)) * front; // прес
    d -= .03 * Math.exp(-((x / .06) ** 2)) * smooth(-3.3, -3.5, y) * front;
    d += .07 * g2(ax, y, .7, -2.5, .45, .55) * back;                           // лопатки
    p.setXYZ(i, x + n.getX(i) * d, y + n.getY(i) * d, z + n.getZ(i) * d);
  }
  g.computeVertexNormals();
  return g;
}

/* ================= СЕРЕДОВИЩЕ ДЛЯ ХРОМУ ================= */
function chromeEnvironment(renderer) {
  const env = new THREE.Scene();
  env.add(new THREE.Mesh(new THREE.SphereGeometry(20, 64, 32), new THREE.ShaderMaterial({
    side: THREE.BackSide,
    vertexShader: `varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
    fragmentShader: `varying vec3 vP;
      float h(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,37.719)))*43758.5453); }
      float n3(vec3 p){ vec3 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
        return mix(mix(mix(h(i),h(i+vec3(1,0,0)),f.x),mix(h(i+vec3(0,1,0)),h(i+vec3(1,1,0)),f.x),f.y),
                   mix(mix(h(i+vec3(0,0,1)),h(i+vec3(1,0,1)),f.x),mix(h(i+vec3(0,1,1)),h(i+vec3(1,1,1)),f.x),f.y),f.z); }
      void main(){
        float y = vP.y;
        vec3 sky = mix(vec3(.9,1.05,1.3), vec3(.02,.1,.42), smoothstep(.02,.45,y));
        float c = n3(vP*4.)*.6 + n3(vP*9.)*.4;
        sky = mix(sky, vec3(1.4,1.45,1.5), smoothstep(.6,.82,c) * smoothstep(.05,.3,y) * (1.-smoothstep(.45,.8,y)));
        vec3 ground = mix(vec3(.005,.008,.015), vec3(.08,.1,.16), smoothstep(-.25,0.,y));
        vec3 col = y > 0. ? sky : ground;
        col += vec3(1.8,1.7,1.5) * pow(max(0., dot(vP, normalize(vec3(-.4,.5,.75)))), 60.) * 4.;
        gl_FragColor = vec4(col, 1.);
      }`
  })));
  const box = (color, k, pos, scale) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(k) }));
    m.position.set(...pos); m.scale.set(...scale); env.add(m);
  };
  box(0x2a9dff, 5, [-9, 1, -4], [1, 9, 7]);
  box(0xffb347, 3.5, [9, 2, -3], [1, 7, 5]);
  box(0xffffff, 2.5, [0, 9, 4], [10, .5, 6]);
  return new THREE.PMREMGenerator(renderer).fromScene(env, .015).texture;
}

function glowSprite(rgb) {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'), grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, `rgba(${rgb},1)`); grd.addColorStop(.25, `rgba(${rgb},.45)`); grd.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Sprite(new THREE.SpriteMaterial({ map: t, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, transparent: true }));
}

export function initAssistant(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.environment = chromeEnvironment(renderer);
  const camera = new THREE.PerspectiveCamera(24, 1, .1, 60);

  const chrome = new THREE.MeshPhysicalMaterial({ color: 0xe6edf5, metalness: 1, roughness: .06, clearcoat: 1, clearcoatRoughness: .04, envMapIntensity: 1.0 });
  const darkSeam = new THREE.MeshStandardMaterial({ color: 0x0a111c, metalness: .8, roughness: .35 });
  const glowCyan = new THREE.MeshBasicMaterial({ color: 0x9fe8ff });
  const glowGold = new THREE.MeshBasicMaterial({ color: 0xffc870 });

  const bust = new THREE.Group(); scene.add(bust);
  const body = new THREE.Mesh(bodyGeometry(), chrome); bust.add(body);
  const head = new THREE.Group(); head.position.y = -.02; head.scale.setScalar(1.1); bust.add(head);
  head.add(new THREE.Mesh(headGeometry(), chrome));

  // Очі — мигдалеподібні лінзи з сяйвом
  const eyes = [];
  [-1, 1].forEach(s => {
    const dir = new THREE.Vector3(.27 * s, .15, .95).normalize(), p = sculpt(dir);
    const lens = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), new THREE.MeshBasicMaterial({ color: 0xc8f4ff }));
    lens.scale.set(.1, .032, .04); lens.position.copy(p).addScaledVector(dir, -.012); lens.rotation.z = s * -.1;
    const glow = glowSprite('110,210,255'); glow.scale.set(.6, .28, 1); glow.position.copy(p).addScaledVector(dir, .05);
    head.add(lens, glow); eyes.push({ lens, glow });
  });

  // Риси андроїда: сяючі лінії на скронях, «аудіо-вузли», шов на черепі
  [-1, 1].forEach(s => {
    head.add(new THREE.Mesh(surfaceTube([[.55 * s, .34, .75], [.8 * s, .22, .35], [.93 * s, .05, -.05], [.82 * s, -.25, -.4], [.6 * s, -.55, -.55]], .003, .008), glowCyan));
    head.add(new THREE.Mesh(surfaceTube([[.68 * s, .5, .45], [.85 * s, .42, .05], [.76 * s, .52, -.4]], .003, .005), glowCyan));
    const dir = new THREE.Vector3(s, .03, -.06).normalize(), p = sculpt(dir);
    const node = new THREE.Group(); node.position.copy(p); node.lookAt(p.clone().add(dir));
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(.14, .17, .06, 48), chrome); disc.rotation.x = Math.PI / 2; node.add(disc);
    const r1 = new THREE.Mesh(new THREE.TorusGeometry(.11, .011, 8, 64), glowCyan); r1.position.z = .035; node.add(r1);
    const r2 = new THREE.Mesh(new THREE.TorusGeometry(.065, .006, 8, 48), glowGold); r2.position.z = .036; node.add(r2);
    head.add(node);
  });
  head.add(new THREE.Mesh(surfaceTube([[0, .62, .78], [0, .97, .25], [0, .88, -.45], [0, .4, -.9]], .002, .005), darkSeam));

  // Шийні сегменти і ядро на грудях
  [-1.3, -1.55].forEach((y, i) => {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(.5 + i * .02, .007, 8, 96), i ? glowCyan : darkSeam);
    ring.rotation.x = Math.PI / 2; ring.position.y = y; ring.scale.y = .92; bust.add(ring);
  });
  const core = new THREE.Group(); core.position.set(0, -2.62, .86); core.rotation.x = -.18; bust.add(core);
  core.add(new THREE.Mesh(new THREE.CircleGeometry(.11, 6), glowGold));
  core.add(new THREE.Mesh(new THREE.TorusGeometry(.19, .014, 6, 6), glowCyan));
  const coreGlow = glowSprite('255,200,110'); coreGlow.scale.set(.7, .7, 1); core.add(coreGlow);

  // Світло
  scene.add(new THREE.AmbientLight(0x6688aa, .15));
  const key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(-3, 4, 5); scene.add(key);
  const rimB = new THREE.PointLight(0x3fb8ff, 55, 14, 2); rimB.position.set(-3.2, 1, -2.5); scene.add(rimB);
  const rimG = new THREE.PointLight(0xffb347, 26, 14, 2); rimG.position.set(3.2, .3, -2); scene.add(rimG);

  // Кадрування: бюст у панелі або великий план у збільшеному режимі
  let big = false;
  function frame() {
    const r = canvas.getBoundingClientRect(); if (!r.width) return;
    renderer.setSize(r.width, r.height, false);
    camera.aspect = r.width / r.height;
    if (big) { camera.position.set(0, -.6, 13.5); camera.lookAt(0, -1.15, 0); }
    else { camera.position.set(0, -.55, 11.2); camera.lookAt(0, -.85, 0); }
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(frame).observe(canvas); frame();

  const ptr = { x: 0, y: 0, sx: 0, sy: 0 };
  addEventListener('pointermove', e => { ptr.x = e.clientX / innerWidth * 2 - 1; ptr.y = e.clientY / innerHeight * 2 - 1; });

  let speaking = 0, listening = false, thinking = false, eco = false, nextBlink = 2, blink = 0;
  const clock = new THREE.Clock();
  const cCyan = new THREE.Color(0xc8f4ff), cGold = new THREE.Color(0xffd27a), cThink = new THREE.Color(0xd9b8ff);
  (function loop() {
    requestAnimationFrame(loop);
    if (document.hidden) return;
    const dt = Math.min(clock.getDelta(), .05), t = clock.elapsedTime, sp = eco ? .4 : 1;
    ptr.sx += (ptr.x - ptr.sx) * .05; ptr.sy += (ptr.y - ptr.sy) * .05;
    head.rotation.y = Math.sin(t * .33 * sp) * .2 + ptr.sx * .4 + (thinking ? Math.sin(t * 1.5) * .08 : 0);
    head.rotation.x = Math.sin(t * .25 * sp) * .04 + ptr.sy * .14 - (thinking ? .08 : .02);
    bust.rotation.y = head.rotation.y * .22;
    const breath = Math.sin(t * 1.1 * sp);
    body.scale.set(1 + breath * .006, 1, 1 + breath * .012); bust.position.y = breath * .02;
    nextBlink -= dt; if (nextBlink < 0) { blink = 1; nextBlink = 2.5 + Math.random() * 4; }
    blink = Math.max(0, blink - dt * 7);
    speaking = Math.max(0, speaking - dt * .5);
    const talk = speaking > 0 ? Math.abs(Math.sin(t * 13)) * .5 : 0;
    const pulse = listening ? .75 + .25 * Math.sin(t * 9) : thinking ? .6 + .4 * Math.sin(t * 4) : .82 + .12 * Math.sin(t * 2) + talk;
    const col = listening ? cGold : thinking ? cThink : cCyan;
    eyes.forEach(({ lens, glow }) => {
      lens.scale.y = .032 * (1 - blink * .9);
      lens.material.color.copy(col);
      glow.material.color.copy(col); glow.material.opacity = Math.min(1, pulse) * (1 - blink * .8);
    });
    coreGlow.material.opacity = .55 + .3 * Math.sin(t * 2) + talk;
    core.rotation.z += dt * (thinking ? 2 : .3);
    renderer.render(scene, camera);
  })();

  return {
    speak(sec = 3) { speaking = Math.min(4, sec / 2); },
    listen(v) { listening = v; },
    think(v) { thinking = v; },
    setBig(v) { big = v; setTimeout(frame, 30); },
    setEco(v) { eco = v; renderer.setPixelRatio(Math.min(devicePixelRatio, v ? 1 : 2)); frame(); }
  };
}
