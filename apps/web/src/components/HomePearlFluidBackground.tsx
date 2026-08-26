import { useEffect, useRef } from 'react';

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
  vec2 drift = vec2(0.035, -0.018) * u_time;
  vec2 cursorFlow = (tangent * (0.075 + length(u_velocity) * 0.16)
    + u_velocity * 0.22) * wake;

  float broad = fbm(p * 2.15 + drift + cursorFlow);
  float folds = fbm(p * 4.0 - vec2(broad * 0.58, broad * 0.34) - drift * 0.7 + cursorFlow * 1.7);
  float ripple = sin(distanceToPointer * 24.0 - u_time * 2.1) * wake * 0.055;
  float field = smoothstep(0.18, 0.88, broad * 0.52 + folds * 0.62 + ripple);

  vec3 pearl = vec3(0.987, 0.978, 0.990);
  vec3 lavender = vec3(0.895, 0.850, 0.952);
  vec3 blush = vec3(0.982, 0.858, 0.910);
  vec3 ice = vec3(0.825, 0.914, 0.965);

  float sheen = 0.5 + 0.5 * sin((folds - broad) * 11.0 + p.x * 3.2 - p.y * 2.1);
  vec3 color = mix(pearl, lavender, field * 0.34);
  color = mix(color, blush, smoothstep(0.56, 0.94, broad + ripple) * 0.19);
  color = mix(color, ice, smoothstep(0.62, 0.96, sheen) * (0.12 + wake * 0.08));
  color += vec3(1.0, 0.995, 0.985) * smoothstep(0.76, 1.0, folds) * 0.08;

  float edge = smoothstep(0.88, 0.12, length((uv - 0.5) * vec2(0.72, 1.0)));
  color = mix(vec3(0.982, 0.976, 0.988), color, 0.72 + edge * 0.28);
  gl_FragColor = vec4(color, 1.0);
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

export function HomePearlFluidBackground() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return;

    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    if (reducedMotion) return;

    const gl = canvas.getContext('webgl', {
      alpha: false,
      antialias: false,
      depth: false,
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
    observer.observe(host);

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
    host.addEventListener('pointermove', onPointerMove, { passive: true });
    host.addEventListener('pointerleave', onPointerLeave);

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
        gl.uniform1f(timeLocation, (now - startedAt) / 1000);
        gl.uniform1f(influenceLocation, influence);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
      animationFrame = requestAnimationFrame(render);
    };
    animationFrame = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(animationFrame);
      observer.disconnect();
      host.removeEventListener('pointermove', onPointerMove);
      host.removeEventListener('pointerleave', onPointerLeave);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    };
  }, []);

  return <canvas ref={canvasRef} className="home-view__pearl-fluid" aria-hidden />;
}
