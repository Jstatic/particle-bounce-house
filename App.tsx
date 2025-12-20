
import React, { useState, useMemo, useRef, useEffect } from 'react';
import { Canvas, useFrame, ThreeElements } from '@react-three/fiber';
import { OrbitControls, PerspectiveCamera, Environment, ContactShadows } from '@react-three/drei';
import * as THREE from 'three';
import { SphereData } from './types';
import { ArrowUpDown, Eye, EyeOff, Menu } from 'lucide-react';

// Properly augment the JSX namespace to include React Three Fiber elements.
// This ensures that tags like <mesh>, <group>, <sphereGeometry>, etc., are recognized.
declare global {
  namespace JSX {
    interface IntrinsicElements extends ThreeElements {}
  }
}

const GRID_SIZE = 12;
const INITIAL_SPACING = 1.2;
const LUT_SIZE = 256;
const MAX_ENGINE_CENTERS = 3;

// Define a proper interface for the visual configuration to replace 'any' types.
interface SceneConfig {
  maxDist: number;
  opacity: number;
  lut: Float32Array;
  minScale: number;
  maxScale: number;
  tintColor: THREE.Color;
  tintColor2: THREE.Color;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

const hsvToRgb = (h: number, s: number, v: number) => {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0: return { r: v, g: t, b: p };
    case 1: return { r: q, g: v, b: p };
    case 2: return { r: p, g: v, b: t };
    case 3: return { r: p, g: q, b: v };
    case 4: return { r: t, g: p, b: v };
    case 5: return { r: v, g: p, b: q };
    default: return { r: v, g: t, b: p };
  }
};

const cubicBezierCoord = (t: number, p0: number, p1: number, p2: number, p3: number) => {
  const cx = 3 * (p1 - p0);
  const bx = 3 * (p2 - p1) - cx;
  const ax = p3 - p0 - cx - bx;
  return ax * Math.pow(t, 3) + bx * Math.pow(t, 2) + cx * t + p0;
};

/**
 * Samples a cubic Bezier defined by (0,startY)-(p1x,p1y)-(p2x,p2y)-(1,endY) at a normalized x (u).
 * Uses a binary search on t since x(t) is monotonic when p1x <= p2x.
 */
const sampleBezierY = (
  u: number,
  p1x: number,
  p1y: number,
  p2x: number,
  p2y: number,
  startY: number,
  endY: number
) => {
  const targetX = clamp01(u);
  let low = 0;
  let high = 1;
  let t = targetX;

  for (let i = 0; i < 24; i++) {
    const mid = (low + high) / 2;
    const x = cubicBezierCoord(mid, 0, p1x, p2x, 1);
    if (Math.abs(x - targetX) < 1e-4) {
      t = mid;
      break;
    }
    if (x < targetX) {
      low = mid;
    } else {
      high = mid;
    }
    t = mid;
  }

  return cubicBezierCoord(t, startY, p1y, p2y, endY);
};

/**
 * Generates a lookup table for sphere scales.
 * Maps distance to a scale value between minScale and maxScale.
 */
const generateScaleLUT = (
  p1x: number,
  p1y: number,
  p2x: number,
  p2y: number,
  startY: number,
  endY: number,
  minScale: number,
  maxScale: number
) => {
  const lut = new Float32Array(LUT_SIZE);
  
  for (let i = 0; i < LUT_SIZE; i++) {
    const t = i / (LUT_SIZE - 1);
    const normalizedVal = sampleBezierY(t, p1x, p1y, p2x, p2y, startY, endY);
    // Map 0-1 range to user-defined min/max bounds
    lut[i] = minScale + normalizedVal * (maxScale - minScale);
  }
  return lut;
};

function generateInitialSpheres(spacing: number): SphereData[] {
  const spheres: SphereData[] = [];
  const offset = (GRID_SIZE - 1) * spacing / 2;

  for (let x = 0; x < GRID_SIZE; x++) {
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let z = 0; z < GRID_SIZE; z++) {
        spheres.push({
          id: `sphere-${x}-${y}-${z}`,
          position: [x * spacing - offset, y * spacing - offset, z * spacing - offset],
          color: '#ffffff',
          scale: 1, 
        });
      }
    }
  }
  return spheres;
}

const BASE_WHITE = new THREE.Color('#ffffff');

type BlendMode = 'normal' | 'additive';

const BLEND_MAP: Record<BlendMode, THREE.Blending> = {
  normal: THREE.NormalBlending,
  additive: THREE.AdditiveBlending,
};

const InstancedSpheres: React.FC<{ 
  baseSpheres: SphereData[];
  focalPointsRef: React.RefObject<THREE.Vector3[]>;
  weightRef: React.RefObject<number[]>;
  config: SceneConfig;
  sphereSegments: number;
  blendMode: BlendMode;
}> = ({ baseSpheres, focalPointsRef, weightRef, config, sphereSegments, blendMode }) => {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const materialRef = useRef<THREE.MeshStandardMaterial>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const tempColor = useMemo(() => new THREE.Color(), []);
  const positions = useMemo(
    () => baseSpheres.map(s => new THREE.Vector3(...s.position)),
    [baseSpheres]
  );

  // Initialize instance colors
  React.useEffect(() => {
    if (meshRef.current) {
      for (let i = 0; i < baseSpheres.length; i++) {
        meshRef.current.setColorAt(i, config.tintColor);
      }
      if (meshRef.current.instanceColor) {
        meshRef.current.instanceColor.needsUpdate = true;
      }
    }
  }, [baseSpheres.length, config.tintColor]);

  React.useEffect(() => {
    if (materialRef.current) {
      materialRef.current.opacity = config.opacity;
      materialRef.current.needsUpdate = true;
    }
  }, [config.opacity]);

  useFrame(() => {
    if (!meshRef.current || !focalPointsRef.current || focalPointsRef.current.length === 0) return;

    const { maxDist, lut, minScale, tintColor, tintColor2 } = config;
    
    for (let i = 0; i < positions.length; i++) {
      const pos = positions[i];
      let dist = Infinity;
      for (let c = 0; c < Math.min(focalPointsRef.current.length, MAX_ENGINE_CENTERS); c++) {
        const w = weightRef.current?.[c] ?? 1;
        if (w < 0.001) continue;
        const d = pos.distanceTo(focalPointsRef.current[c]) / w;
        if (d < dist) dist = d;
      }
      const t = Math.min(1, dist / maxDist);
      const idx = Math.floor(t * (LUT_SIZE - 1));
      const finalScale = lut[idx] || minScale;

      dummy.position.copy(pos);
      dummy.scale.setScalar(finalScale);
      dummy.updateMatrix();
      meshRef.current.setMatrixAt(i, dummy.matrix);

      // Blend colors based on distance: close to focal = tintColor, far = tintColor2
      tempColor.copy(tintColor).lerp(tintColor2, t);
      meshRef.current.setColorAt(i, tempColor);
    }
    meshRef.current.instanceMatrix.needsUpdate = true;
    if (meshRef.current.instanceColor) {
      meshRef.current.instanceColor.needsUpdate = true;
    }
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined as unknown as THREE.BufferGeometry, undefined as unknown as THREE.Material, baseSpheres.length]}
      castShadow
      receiveShadow
    >
      <sphereGeometry args={[1, sphereSegments, sphereSegments]} />
      <meshStandardMaterial 
        ref={materialRef}
        color="#ffffff" 
        emissive="#ffffff" 
        emissiveIntensity={0.15} 
        roughness={0.1} 
        metalness={0.2} 
        transparent
        opacity={config.opacity}
        blending={BLEND_MAP[blendMode]}
        depthWrite={blendMode === 'normal'}
      />
    </instancedMesh>
  );
};

const FocalPointMarker: React.FC<{ focalPointRef: React.RefObject<THREE.Vector3>; visible: boolean }> = ({ focalPointRef, visible }) => {
  const markerRef = useRef<THREE.Mesh>(null);
  const lightRef = useRef<THREE.PointLight>(null);

  useFrame(() => {
    if (markerRef.current && focalPointRef.current) {
      markerRef.current.position.copy(focalPointRef.current);
    }
    if (lightRef.current && focalPointRef.current) {
      lightRef.current.position.copy(focalPointRef.current);
    }
  });

  if (!visible) return null;

  return (
    <group>
      <mesh ref={markerRef}>
        <sphereGeometry args={[0.3, 16, 16]} />
        <meshBasicMaterial color="#ffffff" />
      </mesh>
      <pointLight ref={lightRef} intensity={2} distance={10} color="#ffffff" />
    </group>
  );
};

const SceneContent: React.FC<{
  isDynamic: boolean;
  speed: number;
  engineCenters: number;
  engineRandomness: number;
  sphereSegments: number;
  baseSpheres: SphereData[];
  config: SceneConfig;
  focalPointsRef: React.RefObject<THREE.Vector3[]>;
  showFocalPoint: boolean;
  boundScale: number;
  blendMode: BlendMode;
}> = ({ isDynamic, speed, engineCenters, engineRandomness, sphereSegments, baseSpheres, config, focalPointsRef, showFocalPoint, boundScale, blendMode }) => {
  const phaseRef = useRef<{ px: number; py: number; pz: number; amp: THREE.Vector3; freq: THREE.Vector3 }[]>([]);
  const weightRef = useRef<number[]>([]);
  const weightTargetRef = useRef<number[]>([]);
  const timeRef = useRef(0);
  const smoothRandomnessRef = useRef(engineRandomness);

  // Ensure we have a phase/weights per engine center (max capped)
  useEffect(() => {
    while (phaseRef.current.length < MAX_ENGINE_CENTERS) {
      const jitterAmp = new THREE.Vector3(
        0.6 + Math.random() * 0.8,
        0.6 + Math.random() * 0.8,
        0.6 + Math.random() * 0.8
      );
      const jitterFreq = new THREE.Vector3(
        1 + Math.random() * 0.3,
        1 + Math.random() * 0.3,
        1 + Math.random() * 0.3
      );
      phaseRef.current.push({
        px: Math.random() * Math.PI * 2,
        py: Math.random() * Math.PI * 2,
        pz: Math.random() * Math.PI * 2,
        amp: jitterAmp,
        freq: jitterFreq,
      });
    }
    while (phaseRef.current.length > MAX_ENGINE_CENTERS) {
      phaseRef.current.pop();
    }
    while (focalPointsRef.current.length < MAX_ENGINE_CENTERS) {
      const bound = (GRID_SIZE * INITIAL_SPACING) / 2 * boundScale;
      focalPointsRef.current.push(
        new THREE.Vector3(
          (Math.random() - 0.5) * bound,
          (Math.random() - 0.5) * bound,
          (Math.random() - 0.5) * bound
        )
      );
    }
    while (weightRef.current.length < MAX_ENGINE_CENTERS) {
      weightRef.current.push(0);
    }
    while (weightTargetRef.current.length < MAX_ENGINE_CENTERS) {
      weightTargetRef.current.push(0);
    }
    // Set targets: active centers to 1, inactive to 0
    for (let i = 0; i < MAX_ENGINE_CENTERS; i++) {
      weightTargetRef.current[i] = i < engineCenters ? 1 : 0;
    }
  }, [engineCenters, boundScale]);

  useFrame((state, delta) => {
    if (!isDynamic || !focalPointsRef.current) return;

    timeRef.current += delta * speed;

    // Smooth weights toward targets for gentle fade in/out
    for (let i = 0; i < weightRef.current.length; i++) {
      const current = weightRef.current[i] ?? 0;
      const target = weightTargetRef.current[i] ?? 0;
      weightRef.current[i] = THREE.MathUtils.lerp(current, target, 1 - Math.exp(-delta * 6));
    }

    // Smooth randomness transitions to avoid animation jumps
    smoothRandomnessRef.current = THREE.MathUtils.lerp(
      smoothRandomnessRef.current,
      engineRandomness,
      1 - Math.exp(-delta * 3)
    );

    const baseBound = (GRID_SIZE * INITIAL_SPACING) / 2;
    const bound = baseBound * boundScale;
    const t = timeRef.current;
    const freq = 0.2;
    const randNorm = smoothRandomnessRef.current / 100;

    const centerCount = Math.min(engineCenters, MAX_ENGINE_CENTERS);
    for (let i = 0; i < centerCount; i++) {
      const phase = phaseRef.current[i];
      const freqJitterX = (1.0 + i * 0.1) * THREE.MathUtils.lerp(1, phase.freq.x, randNorm);
      const freqJitterY = (1.35 + i * 0.1) * THREE.MathUtils.lerp(1, phase.freq.y, randNorm);
      const freqJitterZ = (0.8 + i * 0.08) * THREE.MathUtils.lerp(1, phase.freq.z, randNorm);

      const ampJitterX = THREE.MathUtils.lerp(1, phase.amp.x, randNorm);
      const ampJitterY = THREE.MathUtils.lerp(1, phase.amp.y, randNorm);
      const ampJitterZ = THREE.MathUtils.lerp(1, phase.amp.z, randNorm);

      const x = Math.sin(t * freq * freqJitterX + phase.px) * bound * ampJitterX;
      const y = Math.sin(t * freq * freqJitterY + phase.py) * bound * 0.85 * ampJitterY;
      const z = Math.cos(t * freq * freqJitterZ + phase.pz) * bound * ampJitterZ;

      if (!focalPointsRef.current[i]) {
        focalPointsRef.current[i] = new THREE.Vector3();
      }
      focalPointsRef.current[i].set(x, y, z);
    }
  });

  return (
    <group>
      {showFocalPoint && focalPointsRef.current?.slice(0, MAX_ENGINE_CENTERS).map((ref, idx) => (
        weightRef.current[idx] > 0.05 ? (
          <FocalPointMarker key={`fp-${idx}`} focalPointRef={{ current: ref }} visible={true} />
        ) : null
      ))}
      <InstancedSpheres 
        baseSpheres={baseSpheres} 
        focalPointsRef={focalPointsRef} 
        weightRef={weightRef}
        config={config}
        sphereSegments={sphereSegments}
        blendMode={blendMode}
      />
    </group>
  );
};

/**
 * Visual Editor for the Bezier Falloff Curve.
 */
const BezierEditor: React.FC<{
  p1x: number;
  p1y: number;
  p2x: number;
  p2y: number;
  startY: number;
  endY: number;
  onChange: (p1x: number, p1y: number, p2x: number, p2y: number) => void;
  onAnchorChange: (startY: number, endY: number) => void;
  minScale: number;
  maxScale: number;
  accentColor: string;
  accentBorder: string;
}> = ({ p1x, p1y, p2x, p2y, startY, endY, onChange, onAnchorChange, minScale, maxScale, accentColor, accentBorder }) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const [activeHandle, setActiveHandle] = useState<number | null>(null);

  const handlePointerMove = (e: React.PointerEvent) => {
    if (activeHandle === null || !svgRef.current) return;
    e.preventDefault();
    const rect = svgRef.current.getBoundingClientRect();
    const rawX = clamp01((e.clientX - rect.left) / rect.width);
    const y = 1 - clamp01((e.clientY - rect.top) / rect.height);
    const minEdge = 0.01;
    const gap = 0.02;

    if (activeHandle === 1) {
      const x = Math.max(minEdge, Math.min(p2x - gap, rawX));
      onChange(x, y, p2x, p2y);
    } else if (activeHandle === 2) {
      const x = Math.min(1 - minEdge, Math.max(p1x + gap, rawX));
      onChange(p1x, p1y, x, y);
    } else if (activeHandle === 0) {
      // Start anchor - only Y moves
      onAnchorChange(y, endY);
    } else if (activeHandle === 3) {
      // End anchor - only Y moves
      onAnchorChange(startY, y);
    }
  };

  const handlePointerUp = () => setActiveHandle(null);
  
  const path = useMemo(() => {
    const steps = 30;
    let d = `M 0,${(1 - startY) * 100}`;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const y = sampleBezierY(t, p1x, p1y, p2x, p2y, startY, endY);
      d += ` L ${t * 100},${(1 - y) * 100}`;
    }
    return d;
  }, [p1x, p1y, p2x, p2y, startY, endY]);

  return (
    <div className="mt-8 relative bg-black/40 rounded-2xl p-5 border border-white/5 overflow-visible select-none shadow-inner">
      <div className="flex justify-between items-center mb-4">
        <label className="text-[10px] max-[960px]:text-sm uppercase font-bold tracking-widest text-neutral-500">Falloff Curve</label>
      </div>
      <div className="relative group">
        <svg
          ref={svgRef}
          viewBox="0 0 100 100"
          preserveAspectRatio="xMidYMid meet"
          className="w-full -mx-[-3px] h-[190px] max-[960px]:h-[222px] cursor-crosshair touch-none overflow-visible"
          style={{ touchAction: 'none' }}
          onPointerMove={(e) => { if (activeHandle !== null) handlePointerMove(e); }}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          {/* Grid lines */}
          <line x1="0" y1="50" x2="100" y2="50" stroke="rgba(255,255,255,0.05)" strokeWidth="0.5" />
          <line x1="25" y1="0" x2="25" y2="100" stroke="rgba(255,255,255,0.03)" strokeWidth="0.5" />
          <line x1="50" y1="0" x2="50" y2="100" stroke="rgba(255,255,255,0.05)" strokeWidth="0.5" />
          <line x1="75" y1="0" x2="75" y2="100" stroke="rgba(255,255,255,0.03)" strokeWidth="0.5" />
          
          {/* Guide lines to handles */}
          <line x1="0" y1={(1 - startY) * 100} x2={p1x * 100} y2={(1 - p1y) * 100} stroke={accentBorder} strokeWidth="1" strokeDasharray="3" />
          <line x1="100" y1={(1 - endY) * 100} x2={p2x * 100} y2={(1 - p2y) * 100} stroke={accentBorder} strokeWidth="1" strokeDasharray="3" />

          {/* Bezier Path */}
          <path d={path} fill="none" stroke={accentColor} strokeWidth="3" strokeLinecap="round" />

          {/* Draggable Anchors */}
          <circle
            cx="0" cy={(1 - startY) * 100} r="5"
            fill="#ffffff"
            stroke={accentColor}
            strokeWidth="1"
            className="cursor-grab active:cursor-grabbing transition-colors duration-200 shadow-xl pointer-events-none"
          />
          <circle cx="0" cy={(1 - startY) * 100} r="20" fill="transparent" className="cursor-grab touch-none" style={{ touchAction: 'none' }} onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); setActiveHandle(0); }} />
          
          <circle
            cx="100" cy={(1 - endY) * 100} r="5"
            fill="#ffffff"
            stroke={accentColor}
            strokeWidth="1"
            className="cursor-grab active:cursor-grabbing transition-colors duration-200 shadow-xl pointer-events-none"
          />
          <circle cx="100" cy={(1 - endY) * 100} r="20" fill="transparent" className="cursor-grab touch-none" style={{ touchAction: 'none' }} onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); setActiveHandle(3); }} />

          {/* Interactive Handles */}
          <circle
            cx={p1x * 100} cy={(1 - p1y) * 100} r="5"
            fill="#ffffff"
            stroke={accentColor}
            strokeWidth="1"
            className="cursor-grab active:cursor-grabbing transition-colors duration-200 shadow-xl pointer-events-none"
          />
          {/* Invisible hit area for handle 1 - larger on mobile (r="20" = 20px touch target) */}
          <circle cx={p1x * 100} cy={(1 - p1y) * 100} r="20" fill="transparent" className="cursor-grab touch-none" style={{ touchAction: 'none' }} onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); setActiveHandle(1); }} />

          <circle
            cx={p2x * 100} cy={(1 - p2y) * 100} r="5"
            fill="#ffffff"
            stroke={accentColor}
            strokeWidth="1"
            className="cursor-grab active:cursor-grabbing transition-colors duration-200 shadow-xl pointer-events-none"
          />
          {/* Invisible hit area for handle 2 - larger on mobile (r="20" = 20px touch target) */}
          <circle cx={p2x * 100} cy={(1 - p2y) * 100} r="20" fill="transparent" className="cursor-grab touch-none" style={{ touchAction: 'none' }} onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); setActiveHandle(2); }} />
        </svg>
      </div>
      <div className="flex justify-between mt-4 text-[8px] max-[960px]:text-xs font-mono text-neutral-600 uppercase tracking-widest px-1">
        <div className="flex flex-col">
          <span>CENTER</span>
          <span className="text-neutral-500">{(minScale + startY * (maxScale - minScale)).toFixed(2)}x</span>
        </div>
        <div className="flex flex-col text-right">
          <span>EDGE</span>
          <span className="text-neutral-500">{(minScale + endY * (maxScale - minScale)).toFixed(2)}x</span>
        </div>
      </div>
    </div>
  );
};

const HueSlider: React.FC<{
  hue: number;
  onHueChange: (h: number) => void;
  label: string;
  accentColor: string;
  accentSoft: string;
  accentBorder: string;
}> = ({ hue, onHueChange, label, accentColor, accentSoft, accentBorder }) => {
  const hueRef = useRef<HTMLDivElement>(null);

  const updateHue = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!hueRef.current) return;
    const rect = hueRef.current.getBoundingClientRect();
    const h = clamp01((e.clientX - rect.left) / rect.width) * 360;
    onHueChange(h);
  };

  const hueHandleStyle = {
    left: `${(hue / 360) * 100}%`,
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <label className="text-[10px] max-[960px]:text-sm uppercase font-bold text-neutral-500 tracking-wider">{label}</label>
        <span className="text-[10px] max-[960px]:text-sm font-mono px-2 py-0.5 rounded border" style={{ color: accentColor, background: accentSoft, borderColor: accentBorder }}>
          {hue.toFixed(0)}°
        </span>
      </div>

      <div
        ref={hueRef}
        onPointerDown={(e) => { e.preventDefault(); updateHue(e); }}
        onPointerMove={(e) => { if (e.buttons === 1 || e.pointerType === 'touch') updateHue(e); }}
        className="relative h-6 max-[960px]:h-8 rounded-full overflow-hidden shadow-inner cursor-pointer select-none touch-none"
        style={{
          backgroundImage: 'linear-gradient(90deg, #ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000)',
          touchAction: 'none',
        }}
      >
        <div
          className="absolute w-6 h-6 max-[960px]:w-8 max-[960px]:h-8 rounded-full border-4 max-[960px]:border-[5px] border-white shadow-lg -translate-x-1/2 top-1/2 -translate-y-1/2"
          style={hueHandleStyle}
        />
      </div>
    </div>
  );
};

/**
 * Custom Dual-Handle Range Slider for Min/Max Scale
 */
const ScaleRangeSlider: React.FC<{
  min: number; max: number;
  minVal: number; maxVal: number;
  onChange: (min: number, max: number) => void;
  accentColor: string;
  accentShadow: string;
}> = ({ min, max, minVal, maxVal, onChange, accentColor, accentShadow }) => {
  const handleMinChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = Math.min(parseFloat(e.target.value), maxVal - 0.01);
    onChange(value, maxVal);
  };

  const handleMaxChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = Math.max(parseFloat(e.target.value), minVal + 0.01);
    onChange(minVal, value);
  };

  const minPercent = ((minVal - min) / (max - min)) * 100;
  const maxPercent = ((maxVal - min) / (max - min)) * 100;

  return (
    <div className="mt-8 mb-6 px-1">
      <div className="flex justify-between items-center mb-5">
        <label className="text-[10px] max-[960px]:text-sm uppercase font-bold tracking-wider text-neutral-500">Sphere Size</label>
          <div className="text-[10px] max-[960px]:text-sm font-mono bg-neutral-900/50 px-2 py-0.5 rounded border border-white/5 text-neutral-400">
          <span style={{ color: accentColor }}>{minVal.toFixed(2)}x</span> <span className="opacity-30">–</span> <span style={{ color: accentColor }}>{maxVal.toFixed(2)}x</span>
        </div>
      </div>
      <div className="relative h-8 max-[960px]:h-12 flex items-center">
        <div className="absolute w-full h-2 max-[960px]:h-3 bg-neutral-800 rounded-full" />
        <div 
          className="absolute h-2 max-[960px]:h-3 rounded-full" 
          style={{ left: `${minPercent}%`, width: `${maxPercent - minPercent}%`, background: accentColor, boxShadow: accentShadow }}
        />
        <input
          type="range" min={min} max={max} step="0.01" value={minVal}
          onChange={handleMinChange}
          className="absolute w-full pointer-events-none appearance-none bg-transparent touch-none [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:h-5 max-[960px]:[&::-webkit-slider-thumb]:w-7 max-[960px]:[&::-webkit-slider-thumb]:h-7 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:shadow-lg"
          style={{ accentColor, touchAction: 'none' }}
        />
        <input
          type="range" min={min} max={max} step="0.01" value={maxVal}
          onChange={handleMaxChange}
          className="absolute w-full pointer-events-none appearance-none bg-transparent touch-none [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:h-5 max-[960px]:[&::-webkit-slider-thumb]:w-7 max-[960px]:[&::-webkit-slider-thumb]:h-7 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:shadow-lg"
          style={{ accentColor, touchAction: 'none' }}
        />
      </div>
    </div>
  );
};

const App: React.FC = () => {
  const [baseSpheres, setBaseSpheres] = useState<SphereData[]>(() => generateInitialSpheres(INITIAL_SPACING));
  const [opacity, setOpacity] = useState(0.5);
  const [curveStartY, setCurveStartY] = useState(1);
  const [curveEndY, setCurveEndY] = useState(0);
  const [isDynamic, setIsDynamic] = useState(true);
  const [speed, setSpeed] = useState(3.0);
  const [showFocalPoint, setShowFocalPoint] = useState(false);

  // Scale Range Bounds
  const [minScale, setMinScale] = useState(0.03);
  const [maxScale, setMaxScale] = useState(2.0);
  const [hue, setHue] = useState(220); // degrees
  const [hue2, setHue2] = useState(340); // degrees - secondary color for distance blend
  const [sphereSegments, setSphereSegments] = useState(16);
  const [engineCenters, setEngineCenters] = useState(1);
  const [engineRandomness, setEngineRandomness] = useState(0);
  const [boundScale, setBoundScale] = useState(2);
  const [blendMode, setBlendMode] = useState<BlendMode>('normal');
  const [ambientIntensity, setAmbientIntensity] = useState(1);
  const [showUI, setShowUI] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  
  // Camera position - zoom out more on small screens
  const [cameraDistance] = useState(() => {
    if (typeof window !== 'undefined') {
      if (window.innerWidth < 600) {
        return 64; // Zoomed out more for very small screens
      }
      if (window.innerWidth < 960) {
        return 32; // Zoomed out for mobile
      }
    }
    return 20; // Default for desktop
  });
  
  // Track if initial mount is complete to prevent sidebar animation on load
  const [hasMounted, setHasMounted] = useState(false);
  useEffect(() => {
    setHasMounted(true);
  }, []);

  // Bezier Controls
  const [p1x, setP1x] = useState(0.33);
  const [p1y, setP1y] = useState(0.8);
  const [p2x, setP2x] = useState(0.66);
  const [p2y, setP2y] = useState(0.2);

  const tintColor = useMemo(() => {
    const { r, g, b } = hsvToRgb(hue / 360, 1, 1);
    return new THREE.Color(r, g, b);
  }, [hue]);

  const tintColor2 = useMemo(() => {
    const { r, g, b } = hsvToRgb(hue2 / 360, 1, 1);
    return new THREE.Color(r, g, b);
  }, [hue2]);

  const accentColor = useMemo(() => `hsl(${hue}deg, 80%, 60%)`, [hue]);
  const accentSoft = useMemo(() => `hsla(${hue}deg, 80%, 60%, 0.1)`, [hue]);
  const accentBorder = useMemo(() => `hsla(${hue}deg, 80%, 60%, 0.2)`, [hue]);
  const accentShadow = useMemo(() => `0 0 15px hsla(${hue}deg, 80%, 60%, 0.4)`, [hue]);
  const scrollbarThumb = useMemo(() => `hsla(${hue}deg, 30%, 35%, 0.3)`, [hue]);
  const scrollbarTrack = useMemo(() => `hsla(${hue}deg, 30%, 35%, 0.05)`, [hue]);

  const focalPointsRef = useRef<THREE.Vector3[]>([new THREE.Vector3(0, 0, 0)]);

  useEffect(() => {
    // Adjust number of centers and seed new ones randomly within bounds
    const target = engineCenters;
    const current = focalPointsRef.current.length;
    const bound = (GRID_SIZE * INITIAL_SPACING) / boundScale;
    if (target > current) {
      for (let i = current; i < target; i++) {
        focalPointsRef.current.push(
          new THREE.Vector3(
            (Math.random() - 0.5) * bound,
            (Math.random() - 0.5) * bound,
            (Math.random() - 0.5) * bound
          )
        );
      }
    } else if (target < current) {
      focalPointsRef.current = focalPointsRef.current.slice(0, target);
    }
  }, [engineCenters, boundScale]);

  const maxDist = useMemo(() => {
    return Math.sqrt(3 * Math.pow((GRID_SIZE * INITIAL_SPACING) / 2, 2)) * 1.1;
  }, []);

  const lut = useMemo(
    () => generateScaleLUT(p1x, p1y, p2x, p2y, curveStartY, curveEndY, minScale, maxScale),
    [p1x, p1y, p2x, p2y, curveStartY, curveEndY, minScale, maxScale]
  );

  const config: SceneConfig = { maxDist, opacity, lut, minScale, maxScale, tintColor, tintColor2 };

  return (
    <div 
      className="relative w-full h-full text-white font-sans overflow-hidden"
      style={{
        background: 'radial-gradient(circle at center, rgba(255, 255, 255, 0.03) 0%, rgba(0, 0, 0, 0) 40%, rgb(10, 10, 10) 100%)',
        backgroundColor: 'rgb(10, 10, 10)',
      }}
    >
      <style>{`
        .sidebar-scrollbar::-webkit-scrollbar {
          width: 8px;
        }
        .sidebar-scrollbar::-webkit-scrollbar-track {
          background: ${scrollbarTrack};
        }
        .sidebar-scrollbar::-webkit-scrollbar-thumb {
          background: ${scrollbarThumb};
          border-radius: 4px;
        }
        .sidebar-scrollbar::-webkit-scrollbar-thumb:hover {
          background: hsla(${hue}deg, 10%, 20%, 0.1);
        }
      `}</style>
      <Canvas className="w-full h-full" shadows dpr={[1, 1.5]}>
        <PerspectiveCamera makeDefault position={[cameraDistance, cameraDistance, cameraDistance]} />
        <OrbitControls
          makeDefault
          target={[0, 0, 0]}
          autoRotate={!isDynamic}
          autoRotateSpeed={0.3}
          enableDamping
        />
        <ambientLight intensity={ambientIntensity} />
        <spotLight position={[20, 20, 20]} angle={0.2} penumbra={1} intensity={2} castShadow />
        <pointLight position={[-20, -20, -20]} intensity={0.5} />
        
        <SceneContent 
          isDynamic={isDynamic}
          speed={speed}
          engineCenters={engineCenters}
          engineRandomness={engineRandomness}
          sphereSegments={sphereSegments}
          baseSpheres={baseSpheres}
          config={config}
          focalPointsRef={focalPointsRef}
          showFocalPoint={showFocalPoint}
          boundScale={boundScale}
          blendMode={blendMode}
        />

        <ContactShadows position={[0, -GRID_SIZE * 0.8, 0]} opacity={0.4} scale={GRID_SIZE * 4} blur={2.8} far={GRID_SIZE * 2} />
        <Environment preset="night" />
      </Canvas>
      
      {/* Hamburger Menu Button - Mobile Only */}
      {showUI && !drawerOpen && (
        <button
          onClick={() => setDrawerOpen(true)}
          className="max-[960px]:flex hidden lg:hidden absolute bottom-20 right-12 z-30 w-10 h-10 max-[960px]:w-12 max-[960px]:h-12 flex items-center justify-center rounded-lg border border-white/10 bg-neutral-900/80 text-white shadow-2xl backdrop-blur transition hover:border-white/30 hover:bg-neutral-800"
          title="Open Menu"
        >
          <Menu size={18} className="flex-shrink-0 max-[960px]:w-6 max-[960px]:h-6" />
        </button>
      )}

      {/* Overlay - Mobile Only (closes drawer when tapping outside) */}
      {showUI && drawerOpen && (
        <div
          onClick={() => setDrawerOpen(false)}
          className="max-[960px]:block lg:hidden fixed inset-0 z-[5] pointer-events-auto"
        />
      )}

      {/* Sidebar Controls */}
      {showUI && (
        <div
          className={`sidebar-scrollbar absolute top-0 left-0 h-screen w-80 pointer-events-auto flex flex-col gap-8 overflow-y-auto z-10 bg-neutral-900/70 backdrop-blur-2xl max-[960px]:pt-6 max-[960px]:pb-12 ${
            hasMounted ? 'max-[960px]:transition-transform max-[960px]:duration-300 max-[960px]:ease-in-out' : ''
          } ${
            drawerOpen ? 'max-[960px]:translate-x-0' : 'max-[960px]:-translate-x-full'
          } lg:translate-x-0`}
          style={{
            scrollbarWidth: 'thin',
            scrollbarColor: `${scrollbarThumb} ${scrollbarTrack}`,
          }}
        >
          
          {/* Sculpting Section */}
          <div className="pointer-events-auto p-7 shadow-2xl transition-all rounded-none">
            <div className="group space-y-4 mb-8">
              <div className="flex justify-between items-center">
                <label className="text-[10px] max-[960px]:text-sm uppercase font-bold text-neutral-500 tracking-wider">Node Velocity</label>
                <span className="text-[10px] max-[960px]:text-sm font-mono px-2 py-0.5 rounded border" style={{ color: accentColor, background: accentSoft, borderColor: accentBorder }}>{speed.toFixed(1)}x</span>
              </div>
              <input 
                type="range" min="0.1" max="8.0" step="0.1" value={speed} 
                onChange={(e) => setSpeed(parseFloat(e.target.value))}
                className="w-full h-2 max-[960px]:h-4 bg-neutral-800 rounded-lg appearance-none cursor-pointer disabled:opacity-30 transition-all touch-none [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:h-5 max-[960px]:[&::-webkit-slider-thumb]:w-7 max-[960px]:[&::-webkit-slider-thumb]:h-7 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:shadow-lg"
                style={{ accentColor, touchAction: 'none' }}
                disabled={!isDynamic}
              />
            </div>

            <div className="group space-y-4 mb-8">
              <div className="flex justify-between items-center">
                <label className="text-[10px] max-[960px]:text-sm uppercase font-bold text-neutral-500 tracking-wider">Node Centers</label>
              </div>
              <div className="flex gap-2">
                {[1, 2, 3].map(val => (
                  <button
                    key={val}
                    onClick={() => setEngineCenters(val)}
                    className="flex-1 py-2 max-[960px]:py-3 text-[11px] max-[960px]:text-base font-bold uppercase tracking-wider rounded-lg border transition-all bg-neutral-800 text-neutral-400 border-white/10 hover:text-white hover:border-white/30 active:scale-95"
                    style={engineCenters === val ? { background: accentColor, color: '#fff', borderColor: accentBorder, boxShadow: accentShadow } : undefined}
                  >
                    {val}
                  </button>
                ))}
              </div>
            </div>

            <div className="group space-y-4 mb-8">
              <div className="flex justify-between items-center">
                <label className="text-[10px] max-[960px]:text-sm uppercase font-bold text-neutral-500 tracking-wider">Node Randomness</label>
                <span className="text-[10px] max-[960px]:text-sm font-mono px-2 py-0.5 rounded border" style={{ color: accentColor, background: accentSoft, borderColor: accentBorder }}>{engineRandomness.toFixed(0)}%</span>
              </div>
              <input 
                type="range" min="0" max="100" step="1" value={engineRandomness} 
                onChange={(e) => setEngineRandomness(parseInt(e.target.value, 10))}
                className="w-full h-2 max-[960px]:h-4 bg-neutral-800 rounded-lg appearance-none cursor-pointer disabled:opacity-30 transition-all touch-none [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:h-5 max-[960px]:[&::-webkit-slider-thumb]:w-7 max-[960px]:[&::-webkit-slider-thumb]:h-7 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:shadow-lg"
                style={{ accentColor, touchAction: 'none' }}
              />
            </div>

            <div className="space-y-6 mt-10 mb-8">
              <HueSlider 
                hue={hue}
                onHueChange={setHue}
                label="Center Hue"
                accentColor={accentColor}
                accentSoft={accentSoft}
                accentBorder={accentBorder}
              />

              <div className="pt-4 border-t border-white/5">
                <HueSlider 
                  hue={hue2}
                  onHueChange={setHue2}
                  label="Distance Hue"
                  accentColor={`hsl(${hue2}deg, 80%, 60%)`}
                  accentSoft={`hsla(${hue2}deg, 80%, 60%, 0.1)`}
                  accentBorder={`hsla(${hue2}deg, 80%, 60%, 0.2)`}
                />
              </div>
            </div>

            <div className="group space-y-4 mb-8">
              <div className="flex justify-between items-center">
                <label className="text-[10px] max-[960px]:text-sm uppercase font-bold text-neutral-500 tracking-wider">Blend Mode</label>
              </div>
              <div className="flex gap-2">
                {(['normal', 'additive'] as BlendMode[]).map(mode => (
                  <button
                    key={mode}
                    onClick={() => setBlendMode(mode)}
                    className="flex-1 py-2 max-[960px]:py-3 text-[11px] max-[960px]:text-base font-bold uppercase tracking-wider rounded-lg border transition-all bg-neutral-800 text-neutral-400 border-white/10 hover:text-white hover:border-white/30 active:scale-95"
                    style={blendMode === mode ? { background: accentColor, color: '#fff', borderColor: accentBorder, boxShadow: accentShadow } : undefined}
                  >
                    {mode}
                  </button>
                ))}
              </div>
            </div>

            <ScaleRangeSlider 
              min={0.01} max={2.0} 
              minVal={minScale} maxVal={maxScale} 
              onChange={(mi, ma) => { setMinScale(mi); setMaxScale(ma); }} 
              accentColor={accentColor}
              accentShadow={accentShadow}
            />

            <div className="group space-y-4 mb-8">
              <div className="flex justify-between items-center">
                <label className="text-[10px] max-[960px]:text-sm uppercase font-bold text-neutral-500 tracking-wider">Bounds Area</label>
                <span className="text-[10px] max-[960px]:text-sm font-mono px-2 py-0.5 rounded border" style={{ color: accentColor, background: accentSoft, borderColor: accentBorder }}>
                  {boundScale.toFixed(1)}x
                </span>
              </div>
              <input
                type="range"
                min="1"
                max="3"
                step="0.05"
                value={boundScale}
                onChange={(e) => setBoundScale(parseFloat(e.target.value))}
                className="w-full h-2 max-[960px]:h-4 bg-neutral-800 rounded-lg appearance-none cursor-pointer disabled:opacity-30 transition-all touch-none [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:h-5 max-[960px]:[&::-webkit-slider-thumb]:w-7 max-[960px]:[&::-webkit-slider-thumb]:h-7 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:shadow-lg"
                style={{ accentColor, touchAction: 'none' }}
              />
            </div>

            <BezierEditor 
              p1x={p1x} p1y={p1y} p2x={p2x} p2y={p2y}
              startY={curveStartY} endY={curveEndY}
              onChange={(x1, y1, x2, y2) => { setP1x(x1); setP1y(y1); setP2x(x2); setP2y(y2); }}
              onAnchorChange={(sY, eY) => { setCurveStartY(sY); setCurveEndY(eY); }}
              minScale={minScale}
              maxScale={maxScale}
              accentColor={accentColor}
              accentBorder={accentBorder}
            />

            {/* Mobile-only controls (shown on screens < 960px) */}
            <div className="space-y-4 mt-8 max-[960px]:block lg:hidden">
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-4">
                  <span className="text-[10px] max-[960px]:text-sm uppercase font-bold tracking-wider text-neutral-400">Ambient</span>
                  <span className="text-[10px] max-[960px]:text-sm font-mono px-2 py-0.5 rounded border" style={{ color: accentColor, background: accentSoft, borderColor: accentBorder }}>
                    {ambientIntensity.toFixed(2)}
                  </span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="2"
                  step="0.01"
                  value={ambientIntensity}
                  onChange={(e) => setAmbientIntensity(parseFloat(e.target.value))}
                  className="w-full h-2 max-[960px]:h-4 bg-neutral-800 rounded-lg appearance-none cursor-pointer touch-none [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:h-5 max-[960px]:[&::-webkit-slider-thumb]:w-7 max-[960px]:[&::-webkit-slider-thumb]:h-7 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:shadow-lg"
                  style={{ accentColor, touchAction: 'none' }}
                />
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between gap-4">
                  <span className="text-[10px] max-[960px]:text-sm uppercase font-bold tracking-wider text-neutral-400">Atmospheric Density</span>
                  <span className="text-[10px] max-[960px]:text-sm font-mono px-2 py-0.5 rounded border" style={{ color: accentColor, background: accentSoft, borderColor: accentBorder }}>{opacity.toFixed(2)}</span>
                </div>
                <input 
                  type="range" min="0" max="1" step="0.01" value={opacity} 
                  onChange={(e) => setOpacity(parseFloat(e.target.value))}
                  className="w-full h-2 max-[960px]:h-4 bg-neutral-800 rounded-lg appearance-none cursor-pointer transition-all touch-none [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:h-5 max-[960px]:[&::-webkit-slider-thumb]:w-7 max-[960px]:[&::-webkit-slider-thumb]:h-7 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:shadow-lg"
                  style={{ accentColor, touchAction: 'none' }}
                />
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between gap-4">
                  <span className="text-[10px] max-[960px]:text-sm uppercase font-bold tracking-wider text-neutral-400">Sphere Resolution</span>
                  <span className="text-[10px] max-[960px]:text-sm font-mono px-2 py-0.5 rounded border" style={{ color: accentColor, background: accentSoft, borderColor: accentBorder }}>{sphereSegments}</span>
                </div>
                <input
                  type="range"
                  min="4"
                  max="48"
                  step="2"
                  value={sphereSegments}
                  onChange={(e) => setSphereSegments(parseInt(e.target.value, 10))}
                  className="w-full h-2 max-[960px]:h-4 bg-neutral-800 rounded-lg appearance-none cursor-pointer transition-all touch-none [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:h-5 max-[960px]:[&::-webkit-slider-thumb]:w-7 max-[960px]:[&::-webkit-slider-thumb]:h-7 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:shadow-lg"
                  style={{ accentColor, touchAction: 'none' }}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Ambient Light Control - Desktop only (hidden on screens < 960px) */}
      {showUI && (
      <div className="absolute top-4 right-4 pointer-events-auto z-10 bg-neutral-900/80 border border-white/10 rounded-xl px-4 py-4 shadow-2xl backdrop-blur space-y-4 w-72 max-[960px]:hidden">
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-4">
            <span className="text-[10px] max-[960px]:text-sm uppercase font-bold tracking-wider text-neutral-400">Ambient</span>
            <span className="text-[10px] max-[960px]:text-sm font-mono px-2 py-0.5 rounded border" style={{ color: accentColor, background: accentSoft, borderColor: accentBorder }}>
              {ambientIntensity.toFixed(2)}
            </span>
          </div>
          <input
            type="range"
            min="0"
            max="2"
            step="0.01"
            value={ambientIntensity}
            onChange={(e) => setAmbientIntensity(parseFloat(e.target.value))}
            className="w-full h-2 bg-neutral-800 rounded-lg appearance-none cursor-pointer touch-none [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:shadow-lg"
            style={{ accentColor, touchAction: 'none' }}
          />
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-4">
            <span className="text-[10px] max-[960px]:text-sm uppercase font-bold tracking-wider text-neutral-400">Atmospheric Density</span>
            <span className="text-[10px] max-[960px]:text-sm font-mono px-2 py-0.5 rounded border" style={{ color: accentColor, background: accentSoft, borderColor: accentBorder }}>{opacity.toFixed(2)}</span>
          </div>
          <input 
            type="range" min="0" max="1" step="0.01" value={opacity} 
            onChange={(e) => setOpacity(parseFloat(e.target.value))}
            className="w-full h-2 bg-neutral-800 rounded-lg appearance-none cursor-pointer transition-all touch-none [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:shadow-lg"
            style={{ accentColor, touchAction: 'none' }}
          />
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-4">
            <span className="text-[10px] max-[960px]:text-sm uppercase font-bold tracking-wider text-neutral-400">Sphere Resolution</span>
            <span className="text-[10px] max-[960px]:text-sm font-mono px-2 py-0.5 rounded border" style={{ color: accentColor, background: accentSoft, borderColor: accentBorder }}>{sphereSegments}</span>
          </div>
          <input
            type="range"
            min="4"
            max="48"
            step="2"
            value={sphereSegments}
            onChange={(e) => setSphereSegments(parseInt(e.target.value, 10))}
            className="w-full h-2 bg-neutral-800 rounded-lg appearance-none cursor-pointer transition-all touch-none [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:shadow-lg"
            style={{ accentColor, touchAction: 'none' }}
          />
        </div>
      </div>
      )}

      {showUI && !drawerOpen && (
      <div className="absolute bottom-6 max-[960px]:bottom-20 max-[960px]:right-28 right-16 text-right block pointer-events-none z-10 opacity-40 group hover:opacity-100 transition-opacity duration-500">
        <div className="text-[10px] max-[960px]:text-sm text-neutral-400 font-mono tracking-widest space-y-1">
          <p className="font-bold" style={{ color: '#fafafa' }}>PARTICLE BOUNCE HOUSE</p>
          <p>JOHN LEONARD 2025</p>
        </div>
      </div>
      )}

      {/* UI Visibility Toggle */}
      <button
        onClick={() => setShowUI(!showUI)}
        className="absolute bottom-5 max-[960px]:bottom-12 right-4 max-[960px]:right-12 z-20 w-10 h-10 max-[960px]:w-14 max-[960px]:h-14 max-[960px]:hidden flex items-center justify-center rounded-lg border border-white/10 bg-neutral-900/80 text-white shadow-2xl backdrop-blur transition hover:border-white/30 hover:bg-neutral-800"
        title={showUI ? "Hide UI" : "Show UI"}
      >
        {showUI ? <EyeOff size={18} className="max-[960px]:w-6 max-[960px]:h-6" /> : <Eye size={18} className="max-[960px]:w-6 max-[960px]:h-6" />}
      </button>
    </div>
  );
};

export default App;
