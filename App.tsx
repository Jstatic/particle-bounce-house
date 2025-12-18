
import React, { useState, useMemo, useRef, useEffect } from 'react';
import { Canvas, useFrame, ThreeElements } from '@react-three/fiber';
import { OrbitControls, PerspectiveCamera, Environment, ContactShadows } from '@react-three/drei';
import * as THREE from 'three';
import { SphereData } from './types';
import { ArrowUpDown, Eye, EyeOff } from 'lucide-react';

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
  isReversed: boolean,
  minScale: number,
  maxScale: number
) => {
  const lut = new Float32Array(LUT_SIZE);
  const startY = isReversed ? 0 : 1;
  const endY = isReversed ? 1 : 0;
  
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

const InstancedSpheres: React.FC<{ 
  baseSpheres: SphereData[];
  focalPointsRef: React.RefObject<THREE.Vector3[]>;
  weightRef: React.RefObject<number[]>;
  config: SceneConfig;
  sphereSegments: number;
}> = ({ baseSpheres, focalPointsRef, weightRef, config, sphereSegments }) => {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const materialRef = useRef<THREE.MeshStandardMaterial>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const positions = useMemo(
    () => baseSpheres.map(s => new THREE.Vector3(...s.position)),
    [baseSpheres]
  );

  React.useEffect(() => {
    if (materialRef.current) {
      materialRef.current.color.copy(config.tintColor);
      materialRef.current.emissive.copy(BASE_WHITE).lerp(config.tintColor, 0.6);
      materialRef.current.opacity = config.opacity;
      materialRef.current.needsUpdate = true;
    }
  }, [config.tintColor, config.opacity]);

  useFrame(() => {
    if (!meshRef.current || !focalPointsRef.current || focalPointsRef.current.length === 0) return;

    const { maxDist, lut, minScale } = config;
    
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
    }
    meshRef.current.instanceMatrix.needsUpdate = true;
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
}> = ({ isDynamic, speed, engineCenters, engineRandomness, sphereSegments, baseSpheres, config, focalPointsRef, showFocalPoint }) => {
  const phaseRef = useRef<{ px: number; py: number; pz: number; amp: THREE.Vector3; freq: THREE.Vector3 }[]>([]);
  const weightRef = useRef<number[]>([]);
  const weightTargetRef = useRef<number[]>([]);
  const timeRef = useRef(0);

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
      const bound = (GRID_SIZE * INITIAL_SPACING) / 2;
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
  }, [engineCenters]);

  useFrame((state, delta) => {
    if (!isDynamic || !focalPointsRef.current) return;

    timeRef.current += delta * speed;

    // Smooth weights toward targets for gentle fade in/out
    for (let i = 0; i < weightRef.current.length; i++) {
      const current = weightRef.current[i] ?? 0;
      const target = weightTargetRef.current[i] ?? 0;
      weightRef.current[i] = THREE.MathUtils.lerp(current, target, 1 - Math.exp(-delta * 6));
    }

    const bound = (GRID_SIZE * INITIAL_SPACING) / 2 * 2;
    const t = timeRef.current;
    const freq = 0.2;
    const randNorm = engineRandomness / 100;

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
  onChange: (p1x: number, p1y: number, p2x: number, p2y: number) => void;
  isReversed: boolean;
  minScale: number;
  maxScale: number;
  accentColor: string;
  accentBorder: string;
}> = ({ p1x, p1y, p2x, p2y, onChange, isReversed, minScale, maxScale, accentColor, accentBorder }) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const [activeHandle, setActiveHandle] = useState<number | null>(null);

  const handlePointerMove = (e: React.PointerEvent) => {
    if (activeHandle === null || !svgRef.current) return;
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
    }
  };

  const handlePointerUp = () => setActiveHandle(null);

  const startY = isReversed ? 0 : 1;
  const endY = isReversed ? 1 : 0;
  
  const path = useMemo(() => {
    const steps = 30;
    let d = `M 0,${(1 - startY) * 100}`;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const y = sampleBezierY(t, p1x, p1y, p2x, p2y, startY, endY);
      d += ` L ${t * 100},${(1 - y) * 100}`;
    }
    return d;
  }, [p1x, p1y, p2x, p2y, isReversed, startY, endY]);

  return (
    <div className="mt-8 relative bg-black/40 rounded-2xl p-5 border border-white/5 overflow-visible select-none shadow-inner">
      <div className="flex justify-between items-center mb-4">
        <label className="text-[10px] uppercase font-bold tracking-widest text-neutral-500">Falloff Curve</label>
      </div>
      <div className="relative group">
        <svg
          ref={svgRef}
          viewBox="-10 0 120 100"
          preserveAspectRatio="xMidYMid meet"
          className="w-[calc(100%+24px)] -mx-3 h-40 cursor-crosshair touch-none overflow-visible"
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerUp}
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

          {/* Anchors */}
          <circle cx="0" cy={(1 - startY) * 100} r="2.5" fill={accentColor} />
          <circle cx="100" cy={(1 - endY) * 100} r="2.5" fill={accentColor} />

          {/* Interactive Handles */}
          <circle
            cx={p1x * 100} cy={(1 - p1y) * 100} r="5"
            fill="#ffffff"
            stroke={accentColor}
            strokeWidth="1"
            className="cursor-grab active:cursor-grabbing transition-colors duration-200 shadow-xl"
            onPointerDown={(e) => { e.stopPropagation(); setActiveHandle(1); }}
          />
          {/* Invisible hit area for handle 1 */}
          <circle cx={p1x * 100} cy={(1 - p1y) * 100} r="12" fill="transparent" className="cursor-grab" onPointerDown={(e) => { e.stopPropagation(); setActiveHandle(1); }} />

          <circle
            cx={p2x * 100} cy={(1 - p2y) * 100} r="5"
            fill="#ffffff"
            stroke={accentColor}
            strokeWidth="1"
            className="cursor-grab active:cursor-grabbing transition-colors duration-200 shadow-xl"
            onPointerDown={(e) => { e.stopPropagation(); setActiveHandle(2); }}
          />
          {/* Invisible hit area for handle 2 */}
          <circle cx={p2x * 100} cy={(1 - p2y) * 100} r="12" fill="transparent" className="cursor-grab" onPointerDown={(e) => { e.stopPropagation(); setActiveHandle(2); }} />
        </svg>
      </div>
      <div className="flex justify-between mt-4 text-[8px] font-mono text-neutral-600 uppercase tracking-widest px-1">
        <div className="flex flex-col">
          <span>{isReversed ? 'MAX' : 'MIN'} EDGE</span>
          <span className="text-neutral-500">{isReversed ? maxScale.toFixed(1) : minScale.toFixed(1)}x</span>
        </div>
        <div className="flex flex-col text-right">
          <span>CENTER IMPACT</span>
          <span className="text-neutral-500">{isReversed ? minScale.toFixed(1) : maxScale.toFixed(1)}x</span>
        </div>
      </div>
    </div>
  );
};

const ColorPicker: React.FC<{
  hue: number;
  saturation: number;
  value: number;
  onHueChange: (h: number) => void;
  onSaturationValueChange: (s: number, v: number) => void;
  accentColor: string;
  accentSoft: string;
  accentBorder: string;
}> = ({ hue, saturation, value, onHueChange, onSaturationValueChange, accentColor, accentSoft, accentBorder }) => {
  const svRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);

  const updateSV = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!svRef.current) return;
    const rect = svRef.current.getBoundingClientRect();
    const sat = clamp01((e.clientX - rect.left) / rect.width);
    const val = clamp01(1 - (e.clientY - rect.top) / rect.height);
    onSaturationValueChange(sat, val);
  };

  const updateHue = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!hueRef.current) return;
    const rect = hueRef.current.getBoundingClientRect();
    const h = clamp01((e.clientX - rect.left) / rect.width) * 360;
    onHueChange(h);
  };

  const svHandleStyle = {
    left: `${saturation * 100}%`,
    top: `${(1 - value) * 100}%`,
  };

  const hueHandleStyle = {
    left: `${(hue / 360) * 100}%`,
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <label className="text-[10px] uppercase font-bold text-neutral-500 tracking-wider">Color</label>
        <span className="text-[10px] font-mono px-2 py-0.5 rounded border" style={{ color: accentColor, background: accentSoft, borderColor: accentBorder }}>
          {hue.toFixed(0)}° · {(saturation * 100).toFixed(0)}% · {(value * 100).toFixed(0)}%
        </span>
      </div>

      <div
        ref={svRef}
        onPointerDown={(e) => { e.preventDefault(); updateSV(e); }}
        onPointerMove={(e) => { if (e.buttons === 1) updateSV(e); }}
        className="relative h-64 rounded-[1rem] overflow-hidden shadow-inner cursor-crosshair select-none"
        style={{
          backgroundImage: `
            linear-gradient(0deg, #000, rgba(0,0,0,0)),
            linear-gradient(90deg, #fff, hsl(${hue}deg, 100%, 50%))
          `,
        }}
      >
        <div
          className="absolute w-6 h-6 rounded-full border-4 border-white shadow-lg -translate-x-1/2 -translate-y-1/2"
          style={svHandleStyle}
        />
      </div>

      <div
        ref={hueRef}
        onPointerDown={(e) => { e.preventDefault(); updateHue(e); }}
        onPointerMove={(e) => { if (e.buttons === 1) updateHue(e); }}
        className="relative h-6 rounded-full overflow-hidden shadow-inner cursor-pointer select-none"
        style={{
          backgroundImage: 'linear-gradient(90deg, #ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000)',
        }}
      >
        <div
          className="absolute w-6 h-6 rounded-full border-4 border-white shadow-lg -translate-x-1/2 top-1/2 -translate-y-1/2"
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
        <label className="text-[10px] uppercase font-bold tracking-wider text-neutral-500">Dynamic Bounds</label>
          <div className="text-[10px] font-mono bg-neutral-900/50 px-2 py-0.5 rounded border border-white/5 text-neutral-400">
          <span style={{ color: accentColor }}>{minVal.toFixed(2)}x</span> <span className="mx-1 opacity-30">—</span> <span style={{ color: accentColor }}>{maxVal.toFixed(2)}x</span>
        </div>
      </div>
      <div className="relative h-8 flex items-center">
        <div className="absolute w-full h-2 bg-neutral-800 rounded-full" />
        <div 
          className="absolute h-2 rounded-full" 
          style={{ left: `${minPercent}%`, width: `${maxPercent - minPercent}%`, background: accentColor, boxShadow: accentShadow }}
        />
        <input
          type="range" min={min} max={max} step="0.01" value={minVal}
          onChange={handleMinChange}
          className="absolute w-full pointer-events-none appearance-none bg-transparent [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:shadow-lg"
          style={{ accentColor }}
        />
        <input
          type="range" min={min} max={max} step="0.01" value={maxVal}
          onChange={handleMaxChange}
          className="absolute w-full pointer-events-none appearance-none bg-transparent [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:shadow-lg"
          style={{ accentColor }}
        />
      </div>
    </div>
  );
};

const App: React.FC = () => {
  const [baseSpheres, setBaseSpheres] = useState<SphereData[]>(() => generateInitialSpheres(INITIAL_SPACING));
  const [opacity, setOpacity] = useState(0.5);
  const [isReversed, setIsReversed] = useState(false);
  const [isDynamic, setIsDynamic] = useState(true);
  const [speed, setSpeed] = useState(3.0);
  const [showFocalPoint, setShowFocalPoint] = useState(false);

  // Scale Range Bounds
  const [minScale, setMinScale] = useState(0.03);
  const [maxScale, setMaxScale] = useState(2.0);
  const [hue, setHue] = useState(220); // degrees
  const [saturation, setSaturation] = useState(0.75); // 0-1 (X axis)
  const [value, setValue] = useState(0.65); // 0-1 (Y axis, brightness)
  const [sphereSegments, setSphereSegments] = useState(16);
  const [engineCenters, setEngineCenters] = useState(1);
  const [engineRandomness, setEngineRandomness] = useState(0);
  const [ambientIntensity, setAmbientIntensity] = useState(0.5);
  const [showUI, setShowUI] = useState(true);

  // Bezier Controls
  const [p1x, setP1x] = useState(0.33);
  const [p1y, setP1y] = useState(0.8);
  const [p2x, setP2x] = useState(0.66);
  const [p2y, setP2y] = useState(0.2);

  const tintColor = useMemo(() => {
    const { r, g, b } = hsvToRgb(hue / 360, clamp01(saturation), clamp01(value));
    return new THREE.Color(r, g, b);
  }, [hue, saturation, value]);

  const accentColor = useMemo(() => `hsl(${hue}deg, 80%, 60%)`, [hue]);
  const accentSoft = useMemo(() => `hsla(${hue}deg, 80%, 60%, 0.1)`, [hue]);
  const accentBorder = useMemo(() => `hsla(${hue}deg, 80%, 60%, 0.2)`, [hue]);
  const accentShadow = useMemo(() => `0 0 15px hsla(${hue}deg, 80%, 60%, 0.4)`, [hue]);

  const focalPointsRef = useRef<THREE.Vector3[]>([new THREE.Vector3(0, 0, 0)]);

  useEffect(() => {
    // Adjust number of centers and seed new ones randomly within bounds
    const target = engineCenters;
    const current = focalPointsRef.current.length;
    const bound = (GRID_SIZE * INITIAL_SPACING) / 2;
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
  }, [engineCenters]);

  const maxDist = useMemo(() => {
    return Math.sqrt(3 * Math.pow((GRID_SIZE * INITIAL_SPACING) / 2, 2)) * 1.1;
  }, []);

  const lut = useMemo(
    () => generateScaleLUT(p1x, p1y, p2x, p2y, isReversed, minScale, maxScale),
    [p1x, p1y, p2x, p2y, isReversed, minScale, maxScale]
  );

  const config: SceneConfig = { maxDist, opacity, lut, minScale, maxScale, tintColor };

  return (
    <div className="relative w-full h-full bg-neutral-950 text-white font-sans overflow-hidden">
      <Canvas className="w-full h-full" shadows dpr={[1, 1.5]} style={{ transform: 'translateX(100px)' }}>
        <PerspectiveCamera makeDefault position={[20, 20, 20]} />
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
        />

        <ContactShadows position={[0, -GRID_SIZE * 0.8, 0]} opacity={0.4} scale={GRID_SIZE * 4} blur={2.8} far={GRID_SIZE * 2} />
        <Environment preset="night" />
      </Canvas>
      {/* Sidebar Controls */}
      {showUI && (
        <div
          className="absolute top-0 left-0 h-screen w-80 pointer-events-auto flex flex-col gap-8 overflow-y-auto pr-3 scrollbar-hide z-10 bg-neutral-900/70 backdrop-blur-2xl"
          style={{
            scrollbarWidth: 'thin',
            scrollbarColor: '#1f2937 transparent',
            paddingBottom: '24px',
          }}
        >
          
          {/* Sculpting Section */}
          <div className="pointer-events-auto p-7 shadow-2xl transition-all rounded-none h-full">
            <div className="group space-y-4 mb-8">
              <div className="flex justify-between items-center">
                <label className="text-[10px] uppercase font-bold text-neutral-500 tracking-wider">Engine Velocity</label>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded border" style={{ color: accentColor, background: accentSoft, borderColor: accentBorder }}>{speed.toFixed(1)}x</span>
              </div>
              <input 
                type="range" min="0.1" max="8.0" step="0.1" value={speed} 
                onChange={(e) => setSpeed(parseFloat(e.target.value))}
                className="w-full h-2 bg-neutral-800 rounded-lg appearance-none cursor-pointer disabled:opacity-30 transition-all"
                style={{ accentColor }}
                disabled={!isDynamic}
              />
            </div>

            <div className="group space-y-4 mb-8">
              <div className="flex justify-between items-center">
                <label className="text-[10px] uppercase font-bold text-neutral-500 tracking-wider">Engine Centers</label>
              </div>
              <div className="flex gap-2">
                {[1, 2, 3].map(val => (
                  <button
                    key={val}
                    onClick={() => setEngineCenters(val)}
                    className="flex-1 py-2 text-[11px] font-bold uppercase tracking-wider rounded-lg border transition-all bg-neutral-800 text-neutral-400 border-white/10 hover:text-white hover:border-white/30"
                    style={engineCenters === val ? { background: accentColor, color: '#fff', borderColor: accentBorder, boxShadow: accentShadow } : undefined}
                  >
                    {val}
                  </button>
                ))}
              </div>
            </div>

            <div className="group space-y-4 mb-8">
              <div className="flex justify-between items-center">
                <label className="text-[10px] uppercase font-bold text-neutral-500 tracking-wider">Engine Randomness</label>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded border" style={{ color: accentColor, background: accentSoft, borderColor: accentBorder }}>{engineRandomness.toFixed(0)}%</span>
              </div>
              <input 
                type="range" min="0" max="100" step="1" value={engineRandomness} 
                onChange={(e) => setEngineRandomness(parseInt(e.target.value, 10))}
                className="w-full h-2 bg-neutral-800 rounded-lg appearance-none cursor-pointer disabled:opacity-30 transition-all"
                style={{ accentColor }}
              />
            </div>

            <ScaleRangeSlider 
              min={0.01} max={2.0} 
              minVal={minScale} maxVal={maxScale} 
              onChange={(mi, ma) => { setMinScale(mi); setMaxScale(ma); }} 
              accentColor={accentColor}
              accentShadow={accentShadow}
            />

            <BezierEditor 
              p1x={p1x} p1y={p1y} p2x={p2x} p2y={p2y} 
              onChange={(x1, y1, x2, y2) => { setP1x(x1); setP1y(y1); setP2x(x2); setP2y(y2); }} 
              isReversed={isReversed} 
              minScale={minScale}
              maxScale={maxScale}
              accentColor={accentColor}
              accentBorder={accentBorder}
            />

            <div className="space-y-8 mt-10">
              <div className="pb-6">
                <ColorPicker 
                  hue={hue}
                  saturation={saturation}
                  value={value}
                  onHueChange={setHue}
                  onSaturationValueChange={(s, v) => { setSaturation(s); setValue(v); }}
                  accentColor={accentColor}
                  accentSoft={accentSoft}
                  accentBorder={accentBorder}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Ambient Light Control */}
      {showUI && (
      <div className="absolute top-4 right-4 pointer-events-auto z-10 bg-neutral-900/80 border border-white/10 rounded-xl px-4 py-4 shadow-2xl backdrop-blur space-y-4 w-72">
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-4">
            <span className="text-[10px] uppercase font-bold tracking-wider text-neutral-400">Ambient</span>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded border" style={{ color: accentColor, background: accentSoft, borderColor: accentBorder }}>
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
            className="w-full h-2 bg-neutral-800 rounded-lg appearance-none cursor-pointer"
            style={{ accentColor }}
          />
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-4">
            <span className="text-[10px] uppercase font-bold tracking-wider text-neutral-400">Atmospheric Density</span>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded border" style={{ color: accentColor, background: accentSoft, borderColor: accentBorder }}>{opacity.toFixed(2)}</span>
          </div>
          <input 
            type="range" min="0" max="1" step="0.01" value={opacity} 
            onChange={(e) => setOpacity(parseFloat(e.target.value))}
            className="w-full h-2 bg-neutral-800 rounded-lg appearance-none cursor-pointer transition-all"
            style={{ accentColor }}
          />
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-4">
            <span className="text-[10px] uppercase font-bold tracking-wider text-neutral-400">Sphere Resolution</span>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded border" style={{ color: accentColor, background: accentSoft, borderColor: accentBorder }}>{sphereSegments}</span>
          </div>
          <input
            type="range"
            min="4"
            max="48"
            step="2"
            value={sphereSegments}
            onChange={(e) => setSphereSegments(parseInt(e.target.value, 10))}
            className="w-full h-2 bg-neutral-800 rounded-lg appearance-none cursor-pointer transition-all"
            style={{ accentColor }}
          />
        </div>
      </div>
      )}

      {showUI && (
      <div className="absolute bottom-20 right-5 text-right hidden lg:block pointer-events-none z-10 opacity-40 group hover:opacity-100 transition-opacity duration-500">
        <div className="text-[10px] text-neutral-400 font-mono tracking-widest space-y-1">
          <p className="font-bold" style={{ color: accentColor }}>PARTICLE BOUNCE HOUSE</p>
          <p>JOHN LEONARD 2025</p>
        </div>
      </div>
      )}

      {/* UI Visibility Toggle */}
      <button
        onClick={() => setShowUI(!showUI)}
        className="absolute bottom-5 right-4 z-20 w-10 h-10 flex items-center justify-center rounded-lg border border-white/10 bg-neutral-900/80 text-white shadow-2xl backdrop-blur transition hover:border-white/30 hover:bg-neutral-800"
        title={showUI ? "Hide UI" : "Show UI"}
      >
        {showUI ? <EyeOff size={18} /> : <Eye size={18} />}
      </button>
    </div>
  );
};

export default App;
