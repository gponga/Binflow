# Cómo funciona BinFlow

BinFlow lee el proyecto abierto en Premiere, calcula un plan y te lo enseña **antes** de tocar nada. Solo cambia algo cuando confirmas.

## Modos (Ajustes)

| Modo | Qué hace |
|---|---|
| Bins y archivos (recomendado) | Premiere y el disco quedan con la misma estructura. |
| Solo bins en Premiere | No se mueve ningún archivo del disco. |
| Solo archivos del disco | Se re-enlazan en Premiere; los bins no cambian. |

«Solo ver qué hay (no cambia nada)» analiza y enseña el plan sin ejecutarlo.

## Plantillas

La plantilla define las carpetas (`Videos`, `Music & SFX`, `Images`, `VFX & Motion`, `Mascaras`, `Docs`, `Z_Others`…) y qué extensiones van a cada una. Hay varias (Estándar, Documental, YouTube/Reel, Publicidad, Ficción, Personalizado) y la personalizada se puede editar y exportar desde Ajustes. Las secuencias van siempre a `_Secuencias`. La carpeta de assets se llama `01 Assets` por defecto (se puede cambiar).

## Reglas principales

1. **Nada se pierde.** Todo archivo de la carpeta del proyecto se conserva, aunque el proyecto no lo use.
2. **Sin uso, pero a mano.** Los archivos sin uso se quedan junto a su versión usada (por ejemplo `logo.psd` junto a `logo.png`) o van a `_No usados/<categoría>/`. El panel genera un PDF con la lista.
3. **Regla de la mayoría (80 %).** Si un bin tiene al menos un 80 % de un mismo tipo, se conserva entero (por ejemplo `Videos/Brutos/…`) en vez de repartirse.
4. **Medios fuera del proyecto.** Los archivos que están fuera de la carpeta del proyecto (disco externo, otro volumen) se **copian** dentro; los que ya están dentro se **mueven**.
5. **Gráficos de Adobe** (`.aegraphic`, `.mogrt`, `.aep`, `.aet`, `.prgraphic`, `.c4d`): se mueven a su carpeta. Premiere los marcará sin conexión; hay que re-enlazarlos a mano. El panel avisa antes y el informe lista de dónde a dónde se movieron. Se puede desactivar en Ajustes.
6. **No toca** cachés ni carpetas de trabajo de Adobe (`Adobe Premiere Pro Auto-Save`, `Media Cache`, `Peak Files`…), ni `LOG`, `_Final`, `_Finales`, `_Previo`, `Exportaciones`.
7. **Nunca pisa.** Si hay un nombre repetido, no sobrescribe: renombra o lo deja como incidencia.

## Deshacer, cancelar y recuperar

- Cada organización guarda una sesión con lo que ha movido (en una carpeta `LOG` junto al proyecto). **Deshacer** la revierte.
- **Cancelar** durante la ejecución detiene el proceso y deja lo hecho de forma deshacible.
- Si Premiere o el panel se cierran a mitad, al volver puedes **recuperar** la organización interrumpida.

## Informes

Cada organización escribe un informe (HTML y JSON) en la carpeta `LOG`, con lo que se movió, lo que se copió, las incidencias y los gráficos que quedaron sin conexión.

## Límites conocidos

- **Solo macOS** (el instalador y el actualizador usan herramientas del sistema).
- **Sin probar en Premiere real** (ver README).
- El panel no está firmado: necesita el «modo desarrollador» de Adobe (lo activa el instalador).
- Los ajustes se guardan en el almacenamiento local del panel; al cambiar de identificador (`com.gponga.organizer` → `com.binflow.organizer`) pueden no conservarse y habría que volver a elegir plantilla y modo.
