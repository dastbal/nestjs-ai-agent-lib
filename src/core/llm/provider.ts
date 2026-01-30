import { ChatVertexAI, VertexAIEmbeddings } from '@langchain/google-vertexai';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

// 1. Cargar variables de entorno desde la RAÍZ del proyecto
// process.cwd() obtiene la carpeta desde donde ejecutas "npm run agent"
const rootDir = process.cwd();
dotenv.config({ path: path.join(rootDir, '.env.development') });

export class LLMProvider {
  private static instance: ChatVertexAI;

  private constructor() {}

  public static getModel(): ChatVertexAI {
    if (!this.instance) {
      // 2. Validación de variables críticas
      const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

      if (!credentialsPath) {
        throw new Error(
          '❌ GOOGLE_APPLICATION_CREDENTIALS no está definido en el .env',
        );
      }

      // 3. Convertir ruta relativa a ABSOLUTA (Truco para Windows)
      // Si dice "./credentials.json", lo convierte a "C:\Users\...\credentials.json"
      const absoluteCredentialsPath = path.resolve(rootDir, credentialsPath);

      // Verificamos que el archivo JSON realmente exista antes de intentar conectar
      if (!fs.existsSync(absoluteCredentialsPath)) {
        throw new Error(
          `❌ No se encuentra el archivo de credenciales en: ${absoluteCredentialsPath}`,
        );
      }

      // Sobrescribimos la variable de entorno con la ruta absoluta para que la librería de Google la lea bien
      process.env.GOOGLE_APPLICATION_CREDENTIALS = absoluteCredentialsPath;

      console.log(`📄 Usando credenciales: ${absoluteCredentialsPath}`);

      this.instance = new ChatVertexAI({
        // Usamos tus variables específicas
        model:
          process.env.GOOGLE_CLOUD_MODEL_NAME || 'gemini-2.0-flash-lite-001',
        temperature: 0,
        // maxOutputTokens: 8192,
      });
    }
    return this.instance;
  }

  private static embeddingsInstance: VertexAIEmbeddings;

  public static getEmbeddingsModel(): VertexAIEmbeddings {
    if (!this.embeddingsInstance) {
      // Validar credentials igual que antes...

      this.embeddingsInstance = new VertexAIEmbeddings({
        model: 'text-embedding-004', // El modelo más eficiente de Google actualmente
        // Los mismos parámetros de location y projectID que ya configuramos
      });
    }
    return this.embeddingsInstance;
  }
}
