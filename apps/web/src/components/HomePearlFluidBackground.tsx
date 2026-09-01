import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

const FLUID_TIME_SCALE = 1.35;

const VERTEX_SHADER = `
attribute vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `
precision mediump float;

uniform vec2 u_resolution;
uniform vec2 u_pointer;
uniform vec2 u_velocity;
uniform float u_time;
uniform float u_influence;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0)), f.x),
    f.y
  );
}

float fbm(vec2 p) {
  float value = 0.0;
  float amplitude = 0.5;
  mat2 turn = mat2(0.80, -0.60, 0.60, 0.80);
  for (int i = 0; i < 5; i++) {
    value += amplitude * noise(p);
    p = turn * p * 2.02 + 8.31;
    amplitude *= 0.5;
  }
  return value;
}

float pearlSparkle(vec2 p, float scale, float seed, float time) {
  vec2 cellPosition = p * scale;
  vec2 cell = floor(cellPosition);
  vec2 local = fract(cellPosition);
  float random = hash(cell + seed);
  vec2 point = vec2(
    hash(cell + vec2(17.3, 41.7) + seed),
    hash(cell + vec2(53.1, 9.2) + seed)
  );
  float distanceToPoint = length(local - point);
  float glint = 1.0 - smoothstep(0.012, 0.075, distanceToPoint);
  float twinkle = 0.64 + 0.36 * sin(time * (0.42 + random * 0.36) + random * 6.2831);
  return glint * twinkle * smoothstep(0.58, 0.94, random);
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  float aspect = u_resolution.x / max(u_resolution.y, 1.0);
  vec2 p = vec2((uv.x - 0.5) * aspect, uv.y - 0.5);
  vec2 pointer = vec2((u_pointer.x - 0.5) * aspect, u_pointer.y - 0.5);
  vec2 delta = p - pointer;
  float distanceToPointer = length(delta);
  float wake = exp(-distanceToPointer * 4.4) * u_influence;

  vec2 direction = delta / max(distanceToPointer, 0.035);
  vec2 tangent = vec2(-direction.y, direction.x);
  vec2 drift = vec2(0.022, -0.014) * u_time;
  float pointerSpeed = min(length(u_velocity) * 8.0, 1.0);
  vec2 cursorFlow = (tangent * (0.055 + pointerSpeed * 0.12)
    + u_velocity * 0.24) * wake;
  vec2 pearlPosition = p + drift + cursorFlow;

  float film = fbm(pearlPosition * 3.65 + vec2(u_time * 0.032, -u_time * 0.021));
  float microFilm = fbm(pearlPosition * 8.8 - vec2(film * 0.34, film * 0.22));
  float angle = film * 5.8 + microFilm * 2.4 + p.x * 1.8 - p.y * 1.25 + u_time * 0.34;

  float fineSparkle = pearlSparkle(pearlPosition, 112.0, 3.7, u_time);
  float dustSparkle = pearlSparkle(pearlPosition + vec2(0.031, -0.019), 168.0, 19.4, u_time * 0.82);
  float softSparkle = pearlSparkle(pearlPosition - vec2(0.016, 0.027), 72.0, 41.2, u_time * 0.64);
  float sparkle = fineSparkle * 0.78 + dustSparkle * 0.56 + softSparkle * 0.42;

  float cursorSheen = exp(-distanceToPointer * 8.5) * u_influence;
  float directionalGlint = max(0.0, dot(direction, normalize(vec2(0.72, 0.38) + u_velocity * 2.0)));
  float dragRipple = sin(distanceToPointer * 68.0 - u_time * 5.2) * 0.5 + 0.5;
  dragRipple *= exp(-distanceToPointer * 10.5) * u_influence * (0.38 + pointerSpeed * 0.62);
  float cloudStrength = u_influence * (0.42 + pointerSpeed * 0.58);
  vec2 trailOffset = u_velocity * vec2(aspect, 1.0) * 0.9;
  float blueCloud = exp(-length(delta + vec2(0.035, -0.025) + trailOffset * 0.35) * 11.5) * cloudStrength;
  float pinkCloud = exp(-length(delta - vec2(0.045, 0.02) + trailOffset * 0.7) * 12.5) * cloudStrength;
  float violetCloud = exp(-length(delta + vec2(0.012, 0.052) + trailOffset) * 14.0) * cloudStrength;
  sparkle *= 1.0 + cursorSheen * (0.82 + directionalGlint * 0.9);

  vec3 sky = vec3(0.82, 0.91, 1.0);
  vec3 ice = vec3(0.96, 0.985, 1.0);
  vec3 blush = vec3(0.96, 0.62, 0.82);
  vec3 lavender = vec3(0.68, 0.55, 0.96);
  vec3 champagne = vec3(1.0, 0.86, 0.58);

  float broadSheen = 0.5 + 0.5 * sin(angle * 0.86 - u_time * 0.24);
  float ribbonSheen = smoothstep(0.42, 0.9, 0.5 + 0.5 * sin(angle * 1.55 + u_time * 0.18));
  float filmSheen = smoothstep(0.38, 0.84, microFilm);
  vec3 color = mix(sky, ice, broadSheen * 0.64 + filmSheen * 0.22);

  // Preserve the original drifting film. High thresholds make the warm hues
  // appear only in occasional wisps instead of tinting the whole canvas.
  float roseWisp = smoothstep(0.72, 0.95, 0.5 + 0.5 * sin(angle + 2.094));
  float violetWisp = smoothstep(0.78, 0.965, 0.5 + 0.5 * sin(angle * 0.74 - u_time * 0.09 + 4.1));
  float goldWisp = smoothstep(0.84, 0.985, 0.5 + 0.5 * sin(angle * 0.68 + u_time * 0.07 + 5.2));
  color = mix(color, blush, roseWisp * 0.25);
  color = mix(color, lavender, violetWisp * 0.22);
  color = mix(color, champagne, goldWisp * 0.13);
  color = mix(color, vec3(1.0), min(sparkle, 1.0) * 0.46);
  color = mix(color, vec3(0.38, 0.72, 1.0), min(blueCloud * 0.88 + dragRipple * 0.18, 0.88));
  color = mix(color, blush, min(pinkCloud * 0.2, 0.2));
  color = mix(color, lavender, min(violetCloud * 0.2, 0.2));
  float pointerCloud = blueCloud + pinkCloud * 0.24 + violetCloud * 0.24;
  float alpha = 0.036 + broadSheen * 0.058 + ribbonSheen * 0.038
    + filmSheen * 0.02 + sparkle * 0.28
    + (roseWisp + violetWisp + goldWisp) * 0.022
    + pointerCloud * 0.18 + dragRipple * 0.075;
  gl_FragColor = vec4(color, min(alpha, 0.52));
}
`;

function createShader(
  gl: WebGLRenderingContext,
  type: number,
  source: string,
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  gl.deleteShader(shader);
  return null;
}

const PEARL_CYCLES = [46, 39, 53, 43, 57, 36, 61, 49] as const;
const PEARL_DELAYS = [-4, -27, -15, -36, -8, -20, -2, -31] as const;
const PEARL_SMOKE_COLORS = ['#ff72ba', '#8e7dff', '#53cffa', '#64daa0', '#ffd166', '#ff8f70'] as const;

function createPearlFallKeyframes(
  pearl: HTMLElement,
  viewportHeight: number,
  cycleSeconds: number,
): Keyframe[] {
  const size = pearl.offsetHeight;
  const startY = -size - 18;
  const floorY = Math.max(startY, viewportHeight - size - 4);
  const drift = Number.parseFloat(getComputedStyle(pearl).getPropertyValue('--pearl-drift')) || 0;
  const gravity = 560;
  const restitution = 0.46;
  const groundFriction = 0.72;
  const activeSeconds = 6.4;
  const timeStep = 1 / 30;
  let x = 0;
  let y = startY;
  let velocityX = drift / activeSeconds;
  let velocityY = 36;
  let settledAt: number | null = null;
  const frames: Keyframe[] = [];

  for (let elapsed = 0; elapsed <= activeSeconds; elapsed += timeStep) {
    if (elapsed > 0 && settledAt === null) {
      velocityY += gravity * timeStep;
      x += velocityX * timeStep;
      y += velocityY * timeStep;

      if (y >= floorY) {
        y = floorY;
        velocityY = -velocityY * restitution;
        velocityX *= groundFriction;
        if (Math.abs(velocityY) < 72) settledAt = elapsed;
      }
    }

    const fadeIn = Math.min(1, elapsed / 0.18);
    const fadeOut = settledAt === null ? 1 : Math.max(0, 1 - (elapsed - settledAt) / 0.72);
    frames.push({
      offset: elapsed / cycleSeconds,
      opacity: 0.96 * fadeIn * fadeOut,
      transform: `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)`,
    });
  }

  frames.push({
    offset: 1,
    opacity: 0,
    transform: `translate3d(${x.toFixed(2)}px, ${floorY.toFixed(2)}px, 0)`,
  });
  return frames;
}

export function HomePearlFluidBackground() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pearlsRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return;

    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    if (reducedMotion) return;

    const gl = canvas.getContext('webgl', {
      alpha: true,
      antialias: false,
      depth: false,
      premultipliedAlpha: false,
      powerPreference: 'low-power',
      preserveDrawingBuffer: false,
    });
    if (!gl) return;

    const vertex = createShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fragment = createShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    if (!vertex || !fragment) return;

    const program = gl.createProgram();
    const buffer = gl.createBuffer();
    if (!program || !buffer) return;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program);
      return;
    }

    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const position = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    const resolutionLocation = gl.getUniformLocation(program, 'u_resolution');
    const pointerLocation = gl.getUniformLocation(program, 'u_pointer');
    const velocityLocation = gl.getUniformLocation(program, 'u_velocity');
    const timeLocation = gl.getUniformLocation(program, 'u_time');
    const influenceLocation = gl.getUniformLocation(program, 'u_influence');

    let width = 1;
    let height = 1;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      width = Math.max(1, Math.round(rect.width * dpr));
      height = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        gl.viewport(0, 0, width, height);
      }
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    const target = { x: 0.52, y: 0.48 };
    const pointer = { x: target.x, y: target.y };
    const velocity = { x: 0, y: 0 };
    let influence = 0;
    let lastX = target.x;
    let lastY = target.y;

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      const rect = canvas.getBoundingClientRect();
      const x = (event.clientX - rect.left) / Math.max(rect.width, 1);
      const y = 1 - (event.clientY - rect.top) / Math.max(rect.height, 1);
      target.x = Math.max(0, Math.min(1, x));
      target.y = Math.max(0, Math.min(1, y));
      velocity.x += (target.x - lastX) * 0.85;
      velocity.y += (target.y - lastY) * 0.85;
      lastX = target.x;
      lastY = target.y;
      influence = 1;
    };
    const onPointerLeave = () => {
      influence *= 0.45;
    };
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('blur', onPointerLeave);

    const startedAt = performance.now();
    let animationFrame = 0;
    const render = (now: number) => {
      if (!document.hidden) {
        pointer.x += (target.x - pointer.x) * 0.055;
        pointer.y += (target.y - pointer.y) * 0.055;
        velocity.x *= 0.91;
        velocity.y *= 0.91;
        influence *= 0.992;

        gl.uniform2f(resolutionLocation, width, height);
        gl.uniform2f(pointerLocation, pointer.x, pointer.y);
        gl.uniform2f(velocityLocation, velocity.x, velocity.y);
        gl.uniform1f(timeLocation, ((now - startedAt) / 1000) * FLUID_TIME_SCALE);
        gl.uniform1f(influenceLocation, influence);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
      animationFrame = requestAnimationFrame(render);
    };
    animationFrame = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(animationFrame);
      observer.disconnect();
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('blur', onPointerLeave);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    };
  }, []);

  useEffect(() => {
    const layer = pearlsRef.current;
    if (!layer) return;

    const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const timers = new Set<number>();
    let animations: Animation[] = [];
    let resizeFrame = 0;

    const schedule = (callback: () => void, delay: number) => {
      const timer = window.setTimeout(() => {
        timers.delete(timer);
        callback();
      }, delay);
      timers.add(timer);
    };
    const burstPearl = (pearl: HTMLElement) => {
      const rect = pearl.getBoundingClientRect();
      if (rect.width === 0 || Number.parseFloat(getComputedStyle(pearl).opacity) < 0.08) return;

      pearl.style.visibility = 'hidden';
      const smoke = document.createElement('span');
      smoke.className = 'home-view__pearl-smoke';
      smoke.style.left = `${rect.left + rect.width / 2}px`;
      smoke.style.top = `${rect.top + rect.height / 2}px`;

      for (let index = 0; index < 16; index += 1) {
        const particle = document.createElement('i');
        const angle = (index / 16) * Math.PI * 2 + (Math.random() - 0.5) * 0.42;
        const distance = 28 + Math.random() * 48;
        particle.style.setProperty('--smoke-x', `${Math.cos(angle) * distance}px`);
        particle.style.setProperty('--smoke-y', `${Math.sin(angle) * distance - 15}px`);
        particle.style.setProperty('--smoke-size', `${18 + Math.random() * 22}px`);
        particle.style.setProperty('--smoke-delay', `${Math.random() * 90}ms`);
        particle.style.setProperty(
          '--smoke-color',
          PEARL_SMOKE_COLORS[index % PEARL_SMOKE_COLORS.length] ?? PEARL_SMOKE_COLORS[0],
        );
        smoke.appendChild(particle);
      }

      layer.appendChild(smoke);
      schedule(() => smoke.remove(), 1550);
      schedule(() => {
        pearl.style.visibility = '';
      }, 1300);
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target.closest('.home-view__falling-pearl') : null;
      if (!(target instanceof HTMLElement)) return;
      event.preventDefault();
      event.stopPropagation();
      burstPearl(target);
    };

    const rebuildAnimations = () => {
      animations.forEach((animation) => animation.cancel());
      animations = [];
      if (motionPreference.matches) return;

      const pearls = Array.from(layer.querySelectorAll<HTMLElement>('.home-view__falling-pearl'));
      animations = pearls.flatMap((pearl, index) => {
        if (typeof pearl.animate !== 'function') return [];
        const cycleSeconds = PEARL_CYCLES[index] ?? PEARL_CYCLES[0];
        return pearl.animate(createPearlFallKeyframes(pearl, layer.clientHeight, cycleSeconds), {
          duration: cycleSeconds * 1000,
          delay: (PEARL_DELAYS[index] ?? 0) * 1000,
          iterations: Infinity,
          easing: 'linear',
        });
      });
    };
    const scheduleRebuild = () => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(rebuildAnimations);
    };

    rebuildAnimations();
    const observer = new ResizeObserver(scheduleRebuild);
    observer.observe(layer);
    layer.addEventListener('pointerdown', onPointerDown);
    motionPreference.addEventListener('change', rebuildAnimations);

    return () => {
      cancelAnimationFrame(resizeFrame);
      observer.disconnect();
      layer.removeEventListener('pointerdown', onPointerDown);
      motionPreference.removeEventListener('change', rebuildAnimations);
      animations.forEach((animation) => animation.cancel());
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, []);

  if (typeof document === 'undefined') return null;
  return createPortal(
    <>
      <canvas ref={canvasRef} className="home-view__pearl-fluid" aria-hidden />
      <div ref={pearlsRef} className="home-view__falling-pearls" aria-hidden>
        {Array.from({ length: 8 }, (_, index) => (
          <span key={index} className="home-view__falling-pearl" />
        ))}
      </div>
    </>,
    document.body,
  );
}
