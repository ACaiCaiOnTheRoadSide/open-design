import * as React from 'react';

import type { AppTheme } from '../types';

const vertexShaderSource = `
  attribute vec3 a_position;
  attribute vec2 a_texcoord;

  uniform float u_aspect;
  uniform vec2 u_center;
  uniform float u_rotation;
  uniform float u_scale;

  varying vec3 v_normal;
  varying vec2 v_texcoord;

  void main() {
    float spinCos = cos(u_rotation);
    float spinSin = sin(u_rotation);
    vec3 spun = vec3(
      a_position.x * spinCos + a_position.z * spinSin,
      a_position.y,
      -a_position.x * spinSin + a_position.z * spinCos
    );

    const float tilt = 0.12;
    float tiltCos = cos(tilt);
    float tiltSin = sin(tilt);
    vec3 rotated = vec3(
      spun.x,
      spun.y * tiltCos - spun.z * tiltSin,
      spun.y * tiltSin + spun.z * tiltCos
    );

    vec2 screenPosition = u_center
      + vec2(rotated.x / u_aspect, rotated.y) * u_scale;
    gl_Position = vec4(screenPosition, -rotated.z * 0.24, 1.0);
    v_normal = rotated;
    v_texcoord = a_texcoord;
  }
`

const fragmentShaderSource = `
  precision mediump float;

  uniform sampler2D u_lunar_texture;

  varying vec3 v_normal;
  varying vec2 v_texcoord;

  void main() {
    vec3 normal = normalize(v_normal);
    vec3 lightDirection = normalize(vec3(-0.42, 0.38, 0.82));
    float diffuse = max(dot(normal, lightDirection), 0.0);
    float terminator = smoothstep(-0.08, 0.2, dot(normal, lightDirection));

    vec3 albedo = texture2D(u_lunar_texture, v_texcoord).rgb;
    float luminance = dot(albedo, vec3(0.299, 0.587, 0.114));
    albedo = mix(vec3(luminance), albedo, 0.2);
    albedo = pow(albedo, vec3(1.02));

    float edgeShade = smoothstep(0.0, 0.28, normal.z);
    float illumination = (0.035 + diffuse * 0.62) * mix(0.16, 1.0, terminator);
    vec3 color = albedo * illumination * mix(0.68, 1.0, edgeShade);
    color += vec3(0.012, 0.017, 0.024) * pow(1.0 - max(normal.z, 0.0), 4.0) * terminator;

    gl_FragColor = vec4(color, 1.0);
  }
`

type SphereGeometry = {
  indices: Uint16Array
  positions: Float32Array
  texcoords: Float32Array
}

function createSphereGeometry(longitudeSegments: number, latitudeSegments: number): SphereGeometry {
  const positions: number[] = []
  const texcoords: number[] = []
  const indices: number[] = []

  for (let latitudeIndex = 0; latitudeIndex <= latitudeSegments; latitudeIndex += 1) {
    const v = latitudeIndex / latitudeSegments
    const latitude = v * Math.PI - Math.PI / 2
    const ringRadius = Math.cos(latitude)
    const y = Math.sin(latitude)

    for (let longitudeIndex = 0; longitudeIndex <= longitudeSegments; longitudeIndex += 1) {
      const u = longitudeIndex / longitudeSegments
      const longitude = u * Math.PI * 2
      positions.push(
        ringRadius * Math.cos(longitude),
        y,
        ringRadius * Math.sin(longitude)
      )
      texcoords.push(u, v)
    }
  }

  const rowLength = longitudeSegments + 1
  for (let latitudeIndex = 0; latitudeIndex < latitudeSegments; latitudeIndex += 1) {
    for (let longitudeIndex = 0; longitudeIndex < longitudeSegments; longitudeIndex += 1) {
      const topLeft = latitudeIndex * rowLength + longitudeIndex
      const bottomLeft = topLeft + rowLength
      indices.push(topLeft, bottomLeft, topLeft + 1)
      indices.push(topLeft + 1, bottomLeft, bottomLeft + 1)
    }
  }

  return {
    indices: new Uint16Array(indices),
    positions: new Float32Array(positions),
    texcoords: new Float32Array(texcoords),
  }
}

function createShader(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type)
  if (!shader) return null

  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader)
    return null
  }
  return shader
}

function useDarkTheme(theme?: AppTheme): boolean {
  const [systemDark, setSystemDark] = React.useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : false,
  );

  React.useEffect(() => {
    if (
      theme === 'light' ||
      theme === 'dark' ||
      typeof window.matchMedia !== 'function'
    ) return undefined;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = () => setSystemDark(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, [theme]);

  return theme === 'dark' || (theme !== 'light' && systemDark);
}

export function LunarSceneBackground({ theme }: { theme?: AppTheme }) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const [useFallback, setUseFallback] = React.useState(false);
  const dark = useDarkTheme(theme);

  React.useEffect(() => {
    if (!dark || useFallback) return;

    const canvas = canvasRef.current
    if (!canvas) return

    const gl = canvas.getContext("webgl", {
      alpha: false,
      antialias: false,
      depth: true,
      powerPreference: "low-power",
    })
    if (!gl) {
      setUseFallback(true)
      return
    }

    const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource)
    const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource)
    if (!vertexShader || !fragmentShader) {
      setUseFallback(true)
      return
    }

    const program = gl.createProgram()
    if (!program) {
      setUseFallback(true)
      return
    }

    gl.attachShader(program, vertexShader)
    gl.attachShader(program, fragmentShader)
    gl.linkProgram(program)
    gl.deleteShader(vertexShader)
    gl.deleteShader(fragmentShader)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program)
      setUseFallback(true)
      return
    }

    const device = navigator as Navigator & { deviceMemory?: number }
    const lowPowerDevice =
      window.innerWidth < 768 ||
      (device.deviceMemory !== undefined && device.deviceMemory <= 4) ||
      navigator.hardwareConcurrency <= 4
    const geometry = createSphereGeometry(lowPowerDevice ? 56 : 80, lowPowerDevice ? 36 : 52)
    const positionBuffer = gl.createBuffer()
    const texcoordBuffer = gl.createBuffer()
    const indexBuffer = gl.createBuffer()
    const texture = gl.createTexture()
    const positionLocation = gl.getAttribLocation(program, "a_position")
    const texcoordLocation = gl.getAttribLocation(program, "a_texcoord")
    const aspectLocation = gl.getUniformLocation(program, "u_aspect")
    const centerLocation = gl.getUniformLocation(program, "u_center")
    const rotationLocation = gl.getUniformLocation(program, "u_rotation")
    const scaleLocation = gl.getUniformLocation(program, "u_scale")
    const textureLocation = gl.getUniformLocation(program, "u_lunar_texture")

    if (
      !positionBuffer ||
      !texcoordBuffer ||
      !indexBuffer ||
      !texture ||
      positionLocation < 0 ||
      texcoordLocation < 0 ||
      !aspectLocation ||
      !centerLocation ||
      !rotationLocation ||
      !scaleLocation ||
      !textureLocation
    ) {
      gl.deleteProgram(program)
      setUseFallback(true)
      return
    }

    gl.useProgram(program)
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, geometry.positions, gl.STATIC_DRAW)
    gl.enableVertexAttribArray(positionLocation)
    gl.vertexAttribPointer(positionLocation, 3, gl.FLOAT, false, 0, 0)
    gl.bindBuffer(gl.ARRAY_BUFFER, texcoordBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, geometry.texcoords, gl.STATIC_DRAW)
    gl.enableVertexAttribArray(texcoordLocation)
    gl.vertexAttribPointer(texcoordLocation, 2, gl.FLOAT, false, 0, 0)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geometry.indices, gl.STATIC_DRAW)

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.uniform1i(textureLocation, 0)
    gl.enable(gl.DEPTH_TEST)
    gl.depthFunc(gl.LEQUAL)
    gl.clearColor(0.008, 0.012, 0.018, 1)

    const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)")
    let reducedMotion = motionPreference.matches
    let animationFrame = 0
    let disposed = false
    let textureReady = false
    let elapsedSeconds = 0
    let previousTime = performance.now()
    let lastDrawTime = 0
    let pixelRatioCap = lowPowerDevice ? 1 : 1.35
    let frameInterval = 1000 / (lowPowerDevice ? 24 : 30)
    let sampleStart = performance.now()
    let sampledFrames = 0
    let qualityReduced = lowPowerDevice

    const resize = () => {
      const pixelRatio = Math.min(window.devicePixelRatio || 1, pixelRatioCap)
      const width = Math.max(1, Math.floor(window.innerWidth * pixelRatio))
      const height = Math.max(1, Math.floor(window.innerHeight * pixelRatio))
      if (canvas.width === width && canvas.height === height) return
      canvas.width = width
      canvas.height = height
      gl.viewport(0, 0, width, height)
    }

    const draw = (now: number) => {
      if (disposed || !textureReady) return
      animationFrame = 0

      if (!reducedMotion && now - lastDrawTime < frameInterval) {
        animationFrame = requestAnimationFrame(draw)
        return
      }

      const delta = Math.min((now - previousTime) / 1000, 0.06)
      previousTime = now
      if (!reducedMotion) elapsedSeconds += delta
      lastDrawTime = now
      resize()

      const aspect = canvas.width / Math.max(canvas.height, 1)
      const portrait = aspect < 0.9
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
      gl.uniform1f(aspectLocation, aspect)
      gl.uniform2f(centerLocation, portrait ? -0.2 : -0.52, portrait ? 0.44 : 0.15)
      gl.uniform1f(rotationLocation, -0.35 + elapsedSeconds * 0.1)
      gl.uniform1f(scaleLocation, Math.min(0.98, aspect * 0.78))
      gl.drawElements(gl.TRIANGLES, geometry.indices.length, gl.UNSIGNED_SHORT, 0)

      sampledFrames += 1
      if (!qualityReduced && now - sampleStart > 3000) {
        const measuredFps = (sampledFrames * 1000) / (now - sampleStart)
        if (measuredFps < 21) {
          qualityReduced = true
          pixelRatioCap = 0.9
          frameInterval = 1000 / 20
          canvas.width = 1
        }
        sampleStart = now
        sampledFrames = 0
      }

      if (!reducedMotion && !document.hidden) {
        animationFrame = requestAnimationFrame(draw)
      }
    }

    const requestDraw = () => {
      if (!textureReady || document.hidden || animationFrame) return
      previousTime = performance.now()
      animationFrame = requestAnimationFrame(draw)
    }

    const handleVisibilityChange = () => {
      if (document.hidden) {
        cancelAnimationFrame(animationFrame)
        animationFrame = 0
      } else {
        requestDraw()
      }
    }

    const handleMotionPreference = (event: MediaQueryListEvent) => {
      reducedMotion = event.matches
      cancelAnimationFrame(animationFrame)
      animationFrame = 0
      requestDraw()
    }

    const handleContextLost = (event: Event) => {
      event.preventDefault()
      cancelAnimationFrame(animationFrame)
      setUseFallback(true)
    }

    const image = new Image()
    image.decoding = "async"
    image.onload = () => {
      if (disposed) return
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, image)
      gl.generateMipmap(gl.TEXTURE_2D)
      textureReady = true
      requestDraw()
    }
    image.onerror = () => setUseFallback(true)
    // NASA Goddard LRO CGI Moon Kit color map, stored locally to avoid runtime network work.
    image.src = '/backgrounds/lunar-surface.jpg';

    window.addEventListener("resize", resize)
    document.addEventListener("visibilitychange", handleVisibilityChange)
    motionPreference.addEventListener("change", handleMotionPreference)
    canvas.addEventListener("webglcontextlost", handleContextLost)

    return () => {
      disposed = true
      image.onload = null
      image.onerror = null
      cancelAnimationFrame(animationFrame)
      window.removeEventListener("resize", resize)
      document.removeEventListener("visibilitychange", handleVisibilityChange)
      motionPreference.removeEventListener("change", handleMotionPreference)
      canvas.removeEventListener("webglcontextlost", handleContextLost)
      gl.deleteTexture(texture)
      gl.deleteBuffer(indexBuffer)
      gl.deleteBuffer(texcoordBuffer)
      gl.deleteBuffer(positionBuffer)
      gl.deleteProgram(program)
    }
  }, [dark, useFallback]);

  if (!dark) return null;
  if (useFallback) {
    return <div aria-hidden="true" className="app-lunar-fallback" />;
  }

  return <canvas aria-hidden="true" className="app-lunar-atmosphere" ref={canvasRef} />;
}
