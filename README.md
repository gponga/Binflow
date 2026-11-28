# BinFlow

Panel para **Adobe Premiere Pro** que ordena un proyecto de edición: coloca los bins y los archivos en disco con la misma estructura, y antes de tocar nada te enseña qué va a pasar.

> **Estado: sin probar en un Premiere real.** La versión 2.5.0 se ha verificado con pruebas automáticas y con carpetas de prueba, no dentro de Premiere. Úsala con cuidado y avisa de cualquier fallo.
>
> **Usa siempre una COPIA del proyecto**, nunca el original.

## Qué hace

- Analiza el proyecto abierto y propone una estructura (`Videos`, `Music & SFX`, `Images`, `VFX & Motion`, `Docs`…, según la plantilla elegida) con una carpeta `_Secuencias`.
- Mueve los archivos en disco y reordena los bins de Premiere para que coincidan; los medios que estén fuera de la carpeta del proyecto se copian dentro.
- Los archivos que el proyecto no usa se conservan: se quedan junto a su versión usada o van a `_No usados`.
- Cada organización se puede **deshacer**; si se interrumpe, se puede recuperar.
- Los gráficos de Adobe (`.aegraphic`, `.mogrt`, `.aep`…) se mueven a su carpeta; Premiere los marcará sin conexión y hay que re-enlazarlos a mano (el panel lo avisa antes y el informe lista de dónde a dónde).
- Genera un informe de cada organización.

Más detalle en [`docs/como-funciona.md`](docs/como-funciona.md).

## Requisitos

- macOS.
- Adobe Premiere Pro 2019 o posterior (pensado y revisado para Premiere Pro 2027; panel CEP).
- Probar siempre sobre una copia.

## Instalar

1. Descarga `BinFlow-v<versión>.zip` desde la sección **Releases** de este repositorio y descomprímelo.
2. Clic derecho en `Instalar BinFlow.command` → **Abrir** → **Abrir** (la primera vez macOS lo pide; si lo bloquea, repite el clic derecho → Abrir).
3. Cierra Premiere del todo y vuelve a abrirlo. El panel está en **Ventana → Extensiones → BinFlow**.

El instalador activa el «modo desarrollador» de Adobe para paneles sin firmar (CEP 9 a 14), copia el panel a `~/Library/Application Support/Adobe/CEP/extensions/com.binflow.organizer` comprobando que la copia es idéntica, y no deja una instalación a medias si algo falla.

También puedes instalar desde un clon del repositorio: `installer/instalar_plugin.sh`.

### Si tenías una versión antigua

Si en esa carpeta existe `com.gponga.organizer` (el nombre antiguo del panel), el instalador te pregunta si quieres **apartarla** para no tener dos paneles. No la borra: la guarda en una carpeta oculta junto a ella, que puedes borrar a mano cuando compruebes que todo va bien. Opciones: `--quitar-antigua` (sin preguntar) o `--conservar-antigua`.

## Actualizar

El panel comprueba en silencio si hay una versión nueva (`latest.json` en la raíz de este repositorio). Si la hay, aparece un aviso; solo se instala con un clic. Antes de actualizar se guarda una copia de la versión actual y, si algo falla, vuelve a la anterior. Solo se descarga desde `github.com/gponga/Binflow` y `raw.githubusercontent.com/gponga/Binflow`; las descargas de Releases pasan por el host de almacenamiento de GitHub, aceptado únicamente como destino de esa redirección.

## Estructura del repositorio

| Ruta | Contenido |
|---|---|
| `plugin/com.binflow.organizer/` | El panel (CEP): `CSXS/`, `engine/`, `host/`, `ui/`, `fonts/`… |
| `installer/` | `instalar_plugin.sh`, `Instalar BinFlow.command` y `LEEME.txt` |
| `tools/` | `publicar_version.sh` (genera los zips y `latest.json`) y `changelog-publico.json` |
| `tests/` | Pruebas automáticas (Node) |
| `docs/` | Documentación de uso y licencias de terceros |
| `latest.json` | Versión publicada que consulta el actualizador |

## Pruebas

Requieren Node. Cada archivo se ejecuta con una carpeta temporal:

```bash
for f in engine jsx-integration audit-fixes crash-recovery motor-fixes ui-logic graphics-move updater installer; do
  node tests/$f.test.js "$(mktemp -d)"
done
```

## Publicar una versión

`tools/publicar_version.sh` no sube nada: genera en `_salida/` el zip del actualizador, el zip de instalación y `latest.json`. Después se crea la Release `v<versión>` con los dos zips como assets y se sube `latest.json` a la raíz de `main`.

## Licencia

Licencia MIT; ver [`LICENSE`](LICENSE). Las fuentes incluidas (Bebas Neue y Poppins) son de terceros bajo SIL Open Font License 1.1; ver [`docs/licencias-terceros.md`](docs/licencias-terceros.md).
