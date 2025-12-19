# Particle Bounce House

An interactive 3D visualization featuring 1,728 spheres arranged in a 12×12×12 matrix. Sculpt dynamic volumetric forms in real time using animated focal points, customizable falloff curves, and comprehensive visual controls.

## Overview

- **1,728 spheres** arranged in a 12×12×12 matrix, each reacting to one or more moving focal points
- **Dynamic scaling** driven by a cubic Bezier falloff curve with a precomputed lookup table (256 steps) for smooth, GPU-friendly performance
- **Interactive camera controls** with orbit, pan, and zoom, plus physically based lighting, reflections, and soft contact shadows
- **Real-time visual editor** for customizing the sculpting behavior and appearance

## Core Features

### Kinetic Engine
- Toggle animated focal-point motion on/off
- Adjust animation speed (0.1x - 8.0x)
- Control number of active engine centers (1-3)
- Adjust randomness for organic, varied motion patterns
- Optional focal point indicator visualization
- When motion is paused, the camera auto-rotates for a gallery view

### Visual Sculptor
- **Dual-handle scale range slider**: Set min/max scale bounds (0.01x - 2.0x)
- **Interactive Bezier falloff curve editor**: Drag two handles to sculpt the distance-to-scale mapping curve
- **Reverse direction toggle**: Flip the falloff curve direction
- **Atmospheric density control**: Adjust sphere opacity (0-1) for airy or solid appearances
- **HSV color picker**: Full color control with hue, saturation, and value sliders
- **Bounds area control**: Adjust the movement area of focal points (1x - 3x)

### Scene & Camera
- **Orbit**: Left-drag to rotate around the scene
- **Pan**: Right-drag to move the view
- **Zoom**: Scroll to zoom in/out
- **Auto-rotate**: Automatically rotates when animation is paused
- **Lighting**: Night environment preset with ambient, spot, and point lights
- **Contact shadows**: Soft shadows ground the grid

### Rendering & Performance
- **Instanced rendering**: All 1,728 spheres rendered efficiently as a single instanced mesh
- **LUT-based scaling**: Precomputed lookup table ensures stable 60fps performance as focal points move
- **Sphere resolution control**: Adjust sphere geometry detail (4-48 segments)
- **Ambient light intensity**: Fine-tune overall scene brightness (0-2)
- **UI visibility toggle**: Show/hide all controls for a clean view

## Run Locally

**Prerequisites:** Node.js

1. Install dependencies:
   ```bash
   npm install
   ```

2. Run the development server:
   ```bash
   npm run dev
   ```

3. Open your browser to the URL shown in the terminal (typically `http://localhost:5173`)

## Build for Production

```bash
npm run build
```

The built files will be in the `dist` directory.

## Technology Stack

- **React 19** - UI framework
- **Three.js** - 3D graphics engine
- **@react-three/fiber** - React renderer for Three.js
- **@react-three/drei** - Useful helpers for react-three/fiber
- **TypeScript** - Type safety
- **Vite** - Build tool and dev server
