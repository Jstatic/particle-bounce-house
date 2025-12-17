<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# SphereSculpt — 3D Matrix Playground

An interactive 12³ lattice of spheres you can sculpt in real time. Use the kinetic engine, falloff curve editor, and camera controls to create rippling volumetric forms, then reset and explore again.

View your app in AI Studio: https://ai.studio/apps/drive/1S-NgZT_Ji7Mem33dkNScuscGS-xTOpIM

## Overview
- 1,728 spheres arranged in a 12×12×12 matrix, each reacting to a moving focal point.
- Dynamic scaling driven by a cubic Bezier falloff curve and a lookup table for smooth GPU-friendly sampling.
- Orbit, pan, and zoom with physically based lighting, reflections, and soft contact shadows.

## Core Features
- Kinetic Engine: toggle animated focal-point motion, dial speed, and optionally show the focal indicator. When motion is paused, the camera auto-rotates for a gallery view.
- Visual Sculptor: drag dual handles to set min/max scale bounds, sculpt the falloff curve with two draggable Bezier handles, and flip direction with Reverse. Adjust atmospheric density (sphere opacity) for airy or solid looks.
- Scene & Camera: orbit with left-drag, pan with right-drag, scroll to zoom. Night environment lighting plus key/point lights and contact shadows ground the grid.
- Rendering Notes: scaling is sampled from a precomputed LUT (256 steps) for stable performance as the focal point moves.

## Optional AI Transforms
- `services/geminiService.ts` sketches a Gemini 3-based helper to apply scripted matrix changes. Set `API_KEY` in `.env.local` to enable calls; the UI does not invoke it yet, so you can wire it into your own prompts or automation as needed.

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. (Optional) Set `API_KEY` in `.env.local` if you plan to call Gemini transforms
3. Run the app:
   `npm run dev`
