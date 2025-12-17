
import { GoogleGenAI, Type } from "@google/genai";
import { SphereData } from "../types";

// The transformation schema defines the structure of the AI's response for sphere updates.
const transformationSchema = {
  type: Type.OBJECT,
  properties: {
    updates: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          position: {
            type: Type.ARRAY,
            items: { type: Type.NUMBER },
            minItems: 3,
            maxItems: 3,
          },
          color: { type: Type.STRING },
          scale: { type: Type.NUMBER },
        },
        required: ["id"],
      },
    },
    message: { type: Type.STRING, description: "A brief friendly response about what was changed." }
  },
  required: ["updates", "message"],
};

export async function transformMatrix(
  prompt: string,
  currentSpheres: SphereData[]
): Promise<{ updates: Partial<SphereData>[]; message: string }> {
  try {
    // Initialize GoogleGenAI inside the function as per guidelines to use the active API key.
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    
    // Using gemini-3-pro-preview for complex text tasks involving spatial reasoning and coordinates.
    const response = await ai.models.generateContent({
      model: "gemini-3-pro-preview",
      contents: `
        You are a 3D artist controlling a matrix of spheres. 
        Current spheres data: ${JSON.stringify(currentSpheres.slice(0, 20))}... (Total count: ${currentSpheres.length})
        User instruction: "${prompt}"
        
        Return a JSON object with 'updates' (an array of spheres with changed properties) and a 'message'.
        Only include spheres that actually need changing.
        If the user asks to "make everything red", return updates for all sphere IDs with the new color.
        If the user asks for a "wave", modify their Y positions based on X and Z.
      `,
      config: {
        responseMimeType: "application/json",
        responseSchema: transformationSchema,
      },
    });

    // Directly access the text property from the response object as per guidelines.
    const result = JSON.parse(response.text || "{}");
    return result;
  } catch (error) {
    console.error("Gemini transformation error:", error);
    return { updates: [], message: "Sorry, I couldn't process that transformation." };
  }
}
