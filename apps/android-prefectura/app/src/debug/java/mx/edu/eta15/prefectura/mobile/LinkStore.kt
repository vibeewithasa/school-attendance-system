package mx.edu.eta15.prefectura.mobile

import java.io.File
import org.json.JSONException
import org.json.JSONObject

/**
 * Lo unico que se recuerda de la vinculacion: identificadores y la etiqueta. NUNCA claves, codigos ni credenciales de sesion
 * (la clave privada vive en el Keystore y la sesion solo en memoria).
 */
data class LinkRecord(val requestId: String, val deviceId: String?, val label: String, val owner: String? = null)

interface LinkStore {
    fun load(): LinkRecord?

    fun save(record: LinkRecord)

    fun clear()
}

/** Archivo en `noBackupFilesDir`: queda fuera de las copias de seguridad y de la transferencia entre dispositivos. */
class FileLinkStore(directory: File) : LinkStore {
    private val file = File(directory, NAME)

    override fun load(): LinkRecord? {
        if (!file.exists()) return null
        return try {
            val o = JSONObject(file.readText(Charsets.UTF_8))
            LinkRecord(o.getString("requestId"), o.optString("deviceId").takeIf { it.isNotBlank() && it != "null" }, o.getString("label"), o.optString("owner").takeIf { it.isNotBlank() && it != "null" })
        } catch (_: JSONException) {
            null
        }
    }

    override fun save(record: LinkRecord) {
        val json = JSONObject().put("requestId", record.requestId).put("label", record.label)
        record.deviceId?.let { json.put("deviceId", it) }
        record.owner?.let { json.put("owner", it) }
        val temp = File(file.parentFile, "$NAME.tmp")
        temp.writeText(json.toString(), Charsets.UTF_8)
        if (!temp.renameTo(file)) {
            file.delete()
            check(temp.renameTo(file)) { "No se pudo guardar el estado de vinculacion" }
        }
    }

    override fun clear() {
        file.delete()
        File(file.parentFile, "$NAME.tmp").delete()
    }

    private companion object {
        const val NAME = "mobile_link.json"
    }
}
