# Changelog

## 2.5.0 — 2026-11-24
- Botón «Actualizar plugin»: BinFlow avisa cuando hay una versión nueva y se actualiza con un clic.
- Antes de actualizar se guarda una copia de la versión actual; si algo falla, vuelve a la anterior sola.
- Solo avisa cuando de verdad hay una versión nueva; si estás al día o no hay internet, no muestra nada.
- Los gráficos de Adobe (`.aegraphic`, `.mogrt`, `.aep`, `.aet`, `.prgraphic`, `.c4d`) se mueven a su carpeta como el resto; antes de organizar avisa de cuáles quedarán sin conexión en Premiere, y el informe lista de dónde a dónde se movieron. Hay un interruptor en Ajustes.
- Nuevo identificador del panel: `com.binflow.organizer` (antes `com.gponga.organizer`). El instalador ofrece apartar la versión antigua. Marca neutra «BinFlow».
- Las descargas de Releases de GitHub se aceptan solo como redirección desde `github.com/gponga/Binflow/releases/download/`.

## 2.4.1 — 2026-11-24
- Los gráficos de Adobe se mueven con el resto de archivos y se avisa de cuáles quedan sin conexión.
- Nuevo interruptor en Ajustes para mover o no los gráficos de Adobe.

## 2.4.0 — 2026-11-24
- Interfaz nueva: un solo flujo, claro y oscuro según Premiere; cada problema tiene su pantalla con el porqué y qué hacer.
- Arreglo de la carga del panel en Premiere 2027.
- Instalador más seguro: comprueba la copia antes de sustituir la versión anterior.
