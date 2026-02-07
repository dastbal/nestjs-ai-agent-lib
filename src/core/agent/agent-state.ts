/**
 * Representa el estado que se pasa entre los nodos en el LangGraph.
 */
export interface AgentState {
  // Entrada original del usuario
  input: string;
  // Input procesado o estructurado para herramientas específicas
  parsed_input?: any;
  // Lista de nombres de herramientas disponibles para contexto
  tool_names?: string[];
  // El nombre de la herramienta seleccionada/ejecutada en el paso actual
  selected_tool_name?: string | null;
  // La salida o resultado de la última herramienta ejecutada
  tool_result?: string | null;
  // Cualquier error encontrado durante la ejecución
  error?: string | null;
  // Razón de la terminación (ej. success, tool_failed, no_tool_needed)
  finish_reason?: 'success' | 'error' | 'tool_failed' | 'no_tool_needed' | null;
  // Para almacenar la secuencia de llamadas a herramientas y sus resultados
  intermediate_steps?: Array<{ tool: string; input: any; output?: string | null; error?: string | null }>;
  // La respuesta final al usuario
  final_response?: string | null;
}
