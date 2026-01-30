🗺️ Fase 3: The Brain & Knowledge Graph (Plan Mejorado)
Ya no solo "leemos archivos", ahora construimos un Grafo de Conocimiento.

1. Esquema de Base de Datos Expandido (db.ts)
Necesitamos 3 tablas, no 2. La tabla del Grafo es vital para que el agente entienda relaciones ("Si toco este DTO, ¿qué Servicios se rompen?").

Tabla file_registry (Ya existe): Hashes y Esqueletos.

Tabla dependency_graph (NUEVA):

source (Quién importa): src/auth/auth.service.ts

target (Quién es importado): src/users/users.service.ts

type (Relación): import | extends | implements | injects

Tabla code_chunks (MEJORADA para Parent Retrieval):

id: UUID del chunk hijo.

vector: Embedding matemático del hijo.

content: Código del hijo (Método específico).

parent_path: Ruta del archivo padre (src/users/users.service.ts).

metadata: JSON rico ({ "type": "method", "decorators": ["@Cron"] }).

2. The "NestJS Intelligent Chunker" (El Cortador Inteligente)
No usaremos un cortador de texto genérico. Crearemos un NestChunker usando AST (ts-morph) que entiende la anatomía de NestJS.

Lógica de Corte (Chunking Strategy):

Nivel 1: Archivos "Atómicos" (Se guardan enteros)

Tipos: *.dto.ts, *.entity.ts, *.interface.ts, *.enum.ts.

Por qué: Un DTO partido por la mitad no sirve. El agente necesita ver todas las validaciones (@IsString) juntas.

Acción: Chunk = Archivo Completo.

Nivel 2: Archivos de "Lógica" (Se cortan en Métodos + Contexto)

Tipos: *.service.ts, *.controller.ts, *.guard.ts, *.strategy.ts.

Estrategia Parent-Child:

Chunk Padre (Contexto): Se guarda el archivo entero en disco (o DB) para referencia futura.

Chunks Hijos (Búsqueda): Se crea un vector por cada Método.

El Truco: Al vector del método hijo le "pegamos" invisiblemente el contexto de la clase.

Texto a Vectorizar: [Clase: UsersService] [Inyecta: UserRepository] método: create(user) { ... }

Resultado: Si buscas "crear usuario con repositorio", encuentras el método create, aunque el repositorio se defina en el constructor arriba.

Nivel 3: Archivos de "Configuración"

Tipos: *.module.ts, main.ts.

Acción: Se extraen solo las relaciones para la tabla dependency_graph (imports, providers, exports).

3. Flujo de Indexación (El Pipeline)
Cuando el FileRegistry detecta un cambio en users.service.ts:

Parseo AST: ts-morph lee el archivo.

Extracción de Grafo: Detecta import { User } from './user.entity' -> Guarda en tabla dependency_graph.

Chunking Inteligente:

Detecta que es un Service.

Extrae método findAll().

Genera Metadata: { type: 'method', decorator: '@Injectable' }.

Vectorización: Envía el texto del método a Vertex AI.

Guardado Relacional: Guarda en code_chunks vinculando el ID del método con el parent_path del servicio.

📝 Checklist para Aprobación
¿Estás de acuerdo con esta distinción de 3 Niveles para los archivos de NestJS?

Atómicos (DTOs/Entities) -> Todo junto.

Lógica (Services/Controllers) -> Cortado por métodos (Parent-Child).

Config (Modules) -> Solo para el Grafo.

Si te parece bien este plan mejorado, el siguiente paso es instalar ts-morph y configurar la Tabla de Grafos y la Tabla de Vectores en tu db.ts. ¿Procedemos?









Arquitectura del ProyectoEl proyecto está diseñado como una herramienta de CLI (Command Line Interface) que actúa como un puente entre un modelo de lenguaje (Gemini en Vertex AI) y el código fuente de un proyecto NestJS.1. Núcleo del Agente (AgentFactory)Es la fábrica central que ensambla al ingeniero.Motor: Actualmente utiliza createAgent de LangChain para mayor estabilidad.Prompting: Un System Prompt robusto que define al agente como un Principal Software Engineer con estándares inquebrantables de calidad (TSDocs, TDD, DDD, No any).Persistencia: Utiliza SqliteSaver (SQLite) para mantener el historial de las conversaciones entre reinicios del CLI.Memoria a Largo Plazo: Preparado para usar un InMemoryStore o PostgresStore mediante un StoreBackend para guardar preferencias en /memories/.2. Capa de Herramientas (Tools)El agente interactúa con el mundo mediante herramientas especializadas:askCodebaseTool: Un sistema RAG (Retrieval Augmented Generation) que permite al agente buscar patrones y lógica existente en el proyecto antes de proponer cambios.safeWriteFileTool: Permite escribir código en disco con lógica de respaldo (backup) e indexación automática tras la escritura.safeReadFileTool: Obligatorio para el agente leer antes de editar, evitando "alucinaciones" sobre el contenido del archivo.integrityCheckTool: Ejecuta validaciones de compilación o tests para que el agente se auto-corrija si introduce errores.3. Sistema de Archivos Híbrido (Routing)El proyecto utiliza (o está preparado para usar) un CompositeBackend que actúa como enrutador de rutas:/project/*: Acceso al disco real mediante un SafeFilesystemBackend./memories/*: Almacenamiento persistente que sobrevive a los hilos de chat./ (Root): Espacio de trabajo efímero en RAM (StateBackend).⚙️ Especificaciones TécnicasComponenteTecnología / ValorLLM ProviderVertex AI (Gemini)OrquestadorLangGraph / LangChainLímite de Recursión50 pasos (ajustado para tareas complejas)LenguajeTypeScript (Modo Estricto)Patrón de EjecuciónPLAN -> RESEARCH -> IMPLEMENT -> VALIDATE🚀 Estado Actual y DesafíosEstabilidad: Se migró temporalmente de createDeepAgent a createAgent para evitar conflictos de esquemas en el canal "files".HITL (Human-In-The-Loop): El sistema está diseñado para pausar y pedir aprobación antes de realizar cambios críticos en disco.Recursión: Se optimizó el límite de pasos para permitir que el agente realice múltiples búsquedas e intentos de corrección sin detenerse prematuramente.Resumen para el nuevo chat: "Este proyecto es un agente de IA autónomo para ingeniería de software en NestJS. Usa LangGraph para el control de flujo, SQLite para persistencia y herramientas personalizadas para RAG y manipulación segura de archivos. El objetivo es mover esta lógica a una librería reutilizable que implemente el patrón de 'Cirujano': leer, comparar, escribir y validar."