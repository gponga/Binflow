#!/bin/bash
# BinFlow - instalador del panel CEP para Adobe Premiere Pro (macOS).
# Funciona desde cualquier carpeta: siempre usa la carpeta donde está este script.
#
# Uso:   ./instalar_plugin.sh [--target CARPETA] [--no-debug] [--quitar-antigua | --conservar-antigua]
#   --target CARPETA     instala en CARPETA en vez de ~/Library/Application Support/Adobe/CEP/extensions (para pruebas)
#   --no-debug           no toca el «modo desarrollador» de Adobe (para pruebas)
#   --quitar-antigua     si existe la carpeta de la versión antigua (com.gponga.organizer), la aparta SIN preguntar
#   --conservar-antigua  no pregunta por la versión antigua y la deja donde está
#
# Si existe la versión antigua (com.gponga.organizer) y no se indica ninguna de las dos opciones, pregunta.
# Nunca la borra: la aparta a una carpeta oculta junto a ella (Premiere no la carga), que puedes borrar a mano.
#
# Cómo instala: copia a una carpeta temporal junto al destino, comprueba que la copia es idéntica a la
# fuente y que están los archivos clave, y SOLO entonces sustituye la versión instalada. Si algo falla,
# la versión anterior queda intacta.

set -u

PROJECT_NAME="com.binflow.organizer"
OLD_NAME="com.gponga.organizer"
OLD_MODE="ask"
TARGET_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions"
SET_DEBUG=1

usage() {
    sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
    case "$1" in
        --target)
            if [ $# -lt 2 ] || [ -z "$2" ]; then echo "❌ --target necesita una carpeta."; exit 2; fi
            TARGET_DIR="$2"; shift 2 ;;
        --no-debug) SET_DEBUG=0; shift ;;
        --quitar-antigua) OLD_MODE="yes"; shift ;;
        --conservar-antigua) OLD_MODE="no"; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "❌ Opción no reconocida: $1"; usage; exit 2 ;;
    esac
done

# 1. Trabajar siempre desde la carpeta del propio script (no depende de dónde se ejecute)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)" || { echo "❌ No se pudo localizar la carpeta del instalador."; exit 1; }
cd "$SCRIPT_DIR" || exit 1
SOURCE_PATH="$SCRIPT_DIR/$PROJECT_NAME"
# En el zip de instalación el plugin está junto al instalador; en el repositorio, en ../plugin/
[ -d "$SOURCE_PATH" ] || SOURCE_PATH="$SCRIPT_DIR/../plugin/$PROJECT_NAME"
TARGET_PATH="$TARGET_DIR/$PROJECT_NAME"

if [ ! -d "$SOURCE_PATH" ]; then
    echo "❌ ERROR: no encuentro la carpeta '$PROJECT_NAME' junto a este instalador ($SCRIPT_DIR)."
    echo "   → Usa el instalador que viene dentro de la carpeta completa de BinFlow, sin moverlo."
    exit 1
fi

# 2. Versión leída del manifest (no escrita a mano)
MANIFEST="$SOURCE_PATH/CSXS/manifest.xml"
if [ ! -f "$MANIFEST" ]; then
    echo "❌ ERROR: falta $MANIFEST. La carpeta de BinFlow está incompleta; descárgala de nuevo."
    exit 1
fi
VERSION="$(sed -n 's/.*ExtensionBundleVersion="\([^"]*\)".*/\1/p' "$MANIFEST" | head -1)"
[ -n "$VERSION" ] || VERSION="desconocida"

echo "🚀 Iniciando instalación de BinFlow v$VERSION..."

# 3. ¿Premiere abierto? (aviso claro; la instalación sigue, pero hay que reabrirlo)
if pgrep -f "Adobe Premiere Pro" >/dev/null 2>&1; then
    echo "⚠️  Adobe Premiere Pro está ABIERTO."
    echo "   → Se instalará igualmente, pero Premiere no cargará la versión nueva hasta que lo CIERRES del todo y lo vuelvas a abrir."
    echo "   → Lo ideal es cerrarlo antes de instalar."
fi

# 4. Modo Debug de Adobe (CEP 9 a 14), necesario para paneles sin firmar
if [ "$SET_DEBUG" -eq 1 ]; then
    echo "🔧 Activando Modo Desarrollador de Adobe (CEP 9 a 14)..."
    for v in 9 10 11 12 13 14; do
        defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1 2>/dev/null
    done
else
    echo "🔧 Modo Desarrollador de Adobe: sin cambios (--no-debug)."
fi

echo "📁 Asegurando carpeta de destino..."
if ! mkdir -p "$TARGET_DIR"; then
    echo "❌ ERROR: no se pudo crear $TARGET_DIR. Revisa los permisos."
    exit 1
fi

STAGE="$TARGET_DIR/.$PROJECT_NAME.nuevo.$$"
OLD="$TARGET_DIR/.$PROJECT_NAME.anterior.$$"

cleanup() {
    [ -n "${STAGE:-}" ] && [ -d "$STAGE" ] && rm -rf "${STAGE:?}"
}
trap cleanup EXIT

# 5. Copiar a una carpeta temporal junto al destino (sin ocultar errores)
echo "📦 Preparando la copia..."
if ! cp -R "$SOURCE_PATH" "$STAGE"; then
    echo "❌ ERROR: la copia falló. La versión instalada (si había) no se ha tocado."
    echo "   → Revisa los permisos y el espacio de: $TARGET_DIR"
    exit 1
fi

# 6. Excluir basura de macOS
find "$STAGE" \( -name '.DS_Store' -o -name '._*' \) -exec rm -rf {} + 2>/dev/null

# 7. Verificar que la copia es idéntica a la fuente (ignorando esa basura) y que están los archivos clave
if ! diff -r -x '.DS_Store' -x '._*' "$SOURCE_PATH" "$STAGE" >/dev/null 2>&1; then
    echo "❌ ERROR: la copia no es idéntica a la original (se habría instalado a medias)."
    echo "   La versión instalada (si había) no se ha tocado. Inténtalo de nuevo y, si se repite, avisa."
    exit 1
fi
MISSING=""
for f in CSXS/manifest.xml index.html main.js ui/ui-logic.js host/ext.jsx; do
    [ -f "$STAGE/$f" ] || MISSING="$MISSING $f"
done
for d in engine fonts; do
    [ -d "$STAGE/$d" ] || MISSING="$MISSING $d/"
done
if [ -n "$MISSING" ]; then
    echo "❌ ERROR: a la copia le faltan archivos imprescindibles:$MISSING"
    echo "   La versión instalada (si había) no se ha tocado. La carpeta de BinFlow está incompleta; descárgala de nuevo."
    exit 1
fi

# 8. Sustituir la versión instalada (la anterior solo se borra cuando la nueva ya está en su sitio)
if [ -e "$TARGET_PATH" ]; then
    echo "🔓 Quitando flags de protección de la versión anterior..."
    chflags -R nouchg "$TARGET_PATH" 2>/dev/null
    chmod -R u+w "$TARGET_PATH" 2>/dev/null
    if ! mv "$TARGET_PATH" "$OLD"; then
        echo "❌ ERROR: no se pudo apartar la versión anterior. No se ha cambiado nada."
        echo "   → Cierra Adobe Premiere Pro y vuelve a probar."
        exit 1
    fi
fi
if ! mv "$STAGE" "$TARGET_PATH"; then
    echo "❌ ERROR: no se pudo colocar la versión nueva."
    if [ -e "$OLD" ] && mv "$OLD" "$TARGET_PATH"; then
        echo "   La versión anterior se ha restaurado."
    elif [ -e "$OLD" ]; then
        echo "   La versión anterior quedó en: $OLD"
    fi
    exit 1
fi
if [ -e "$OLD" ]; then
    chmod -R u+w "$OLD" 2>/dev/null
    rm -rf "${OLD:?}"
fi

# 9. Versión antigua (otro id de panel): si sigue instalada, Premiere mostraría dos paneles
OLD_PATH="$TARGET_DIR/$OLD_NAME"
if [ -e "$OLD_PATH" ]; then
    echo ""
    echo "⚠️  Hay una versión antigua de BinFlow instalada: $OLD_PATH"
    echo "   Si la dejas, Premiere mostrará DOS paneles de BinFlow."
    DO_OLD=0
    case "$OLD_MODE" in
        yes) DO_OLD=1 ;;
        no) echo "   (Se deja como está.)" ;;
        *)
            printf "   ¿Quieres apartarla ahora? No se borra: se guarda en una carpeta oculta junto a ella. [s/N] "
            ANS=""; read -r ANS || ANS=""
            case "$ANS" in s|S|si|SI|sí|Sí|y|Y|yes) DO_OLD=1 ;; *) echo "   Vale, se deja como está (puedes repetir la instalación cuando quieras)." ;; esac ;;
    esac
    if [ "$DO_OLD" -eq 1 ]; then
        APART="$TARGET_DIR/.$OLD_NAME.antigua.$(date +%Y%m%d-%H%M%S)"
        chflags -R nouchg "$OLD_PATH" 2>/dev/null
        chmod -R u+w "$OLD_PATH" 2>/dev/null
        if mv "$OLD_PATH" "$APART"; then
            echo "   ✅ Apartada en: $APART"
            echo "      (Premiere no la carga. Cuando compruebes que todo va bien, puedes borrar esa carpeta a mano.)"
        else
            echo "   ❌ No se pudo apartar la versión antigua. Bórrala o muévela a mano: $OLD_PATH"
        fi
    fi
fi

echo "✅ Instalación completada con éxito (BinFlow v$VERSION en $TARGET_PATH)."
echo ""
echo "✨ ¡Listo! Ahora abre (o reinicia) Adobe Premiere Pro."
echo "Encontrarás el panel en: Ventana > Extensiones > BinFlow"
echo ""
echo "📋 Si algo falla: en el panel, Ajustes > Diagnóstico > «Ejecutar diagnóstico»."
