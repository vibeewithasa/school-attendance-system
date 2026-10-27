package mx.edu.eta15.prefectura.demo

/**
 * Identificadores de perfil. El perfil de DEMOSTRACION no es una cuenta escolar ni representa permisos reales: es solo
 * el contenedor local de datos 100 % ficticios. En release no existe ninguna implementacion que lo cree
 * (ver `src/release/.../DemoMode.kt`).
 */
const val DEMO_PROFILE_ID = "demo-prefecta"

/** Perfil usado cuando no hay sesion ni demostracion: no tiene datos y no se puede capturar nada. */
const val NO_SESSION_PROFILE_ID = "sin-sesion"
