#!/bin/bash
# BinFlow - prepara una versión para publicar (NO sube nada).
# Genera, en la carpeta de salida (por defecto _salida/ en la raíz del repo, ignorada por git):
#   BinFlow-<versión>.zip    actualizador: solo plugin/com.binflow.organizer/ (asset de la Release; sin .DS_Store, ._*, .debug ni tests)
#   BinFlow-v<versión>.zip   instalación a mano: Instalar BinFlow.command + instalar_plugin.sh + LEEME.txt + el plugin
#   latest.json              versión, fecha, url, sha256, tamaño y changelog (de tools/changelog-publico.json)
# Después, a mano: crear la Release v<versión> en GitHub con los dos zips como assets y subir latest.json a la raíz de main.
#
# Uso:   tools/publicar_version.sh [--out CARPETA] [--url-base URL]
#   --out CARPETA   carpeta de salida (no debe existir ya con esos archivos)
#   --url-base URL  carpeta pública donde estará el zip del actualizador
#                   (por defecto https://github.com/gponga/Binflow/releases/download/v<versión>)

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)" || exit 1
REPO="$(cd "$SCRIPT_DIR/.." && pwd)" || exit 1
cd "$REPO" || exit 1
PROJECT_NAME="com.binflow.organizer"
PLUGIN="plugin/$PROJECT_NAME"
OUT="$REPO/_salida"
URL_BASE=""

while [ $# -gt 0 ]; do
    case "$1" in
        --out) [ $# -ge 2 ] && [ -n "$2" ] || { echo "❌ --out necesita una carpeta."; exit 2; }; OUT="$2"; shift 2 ;;
        --url-base) [ $# -ge 2 ] && [ -n "$2" ] || { echo "❌ --url-base necesita una dirección."; exit 2; }; URL_BASE="${2%/}"; shift 2 ;;
        -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "❌ Opción no reconocida: $1"; exit 2 ;;
    esac
done

MANIFEST="$PLUGIN/CSXS/manifest.xml"
[ -f "$MANIFEST" ] || { echo "❌ No encuentro $MANIFEST."; exit 1; }
VERSION="$(sed -n 's/.*ExtensionBundleVersion="\([^"]*\)".*/\1/p' "$MANIFEST" | head -1)"
ENGINE_VERSION="$(sed -n "s/.*'\([0-9.]*\)'.*/\1/p" "$PLUGIN/engine/version.js" | head -1)"
case "$VERSION" in [0-9]*.[0-9]*.[0-9]*) ;; *) echo "❌ Versión no válida en el manifest: '$VERSION'"; exit 1 ;; esac
[ "$VERSION" = "$ENGINE_VERSION" ] || { echo "❌ La versión del manifest ($VERSION) y la de engine/version.js ($ENGINE_VERSION) no coinciden."; exit 1; }
CHANGELOG="tools/changelog-publico.json"
[ -f "$CHANGELOG" ] || { echo "❌ Falta $CHANGELOG."; exit 1; }
grep -q "\"version\": *\"$VERSION\"" "$CHANGELOG" || { echo "❌ $CHANGELOG no tiene entrada para la versión $VERSION."; exit 1; }
[ -f installer/instalar_plugin.sh ] && [ -f "installer/Instalar BinFlow.command" ] && [ -f installer/LEEME.txt ] || { echo "❌ Falta algo en installer/ (instalar_plugin.sh, Instalar BinFlow.command, LEEME.txt)."; exit 1; }

[ -n "$URL_BASE" ] || URL_BASE="https://github.com/gponga/Binflow/releases/download/v$VERSION"
case "$URL_BASE" in https://raw.githubusercontent.com/gponga/Binflow/*|https://github.com/gponga/Binflow/*) ;; *) echo "❌ La dirección debe ser https://github.com/gponga/Binflow/... o https://raw.githubusercontent.com/gponga/Binflow/..."; exit 2 ;; esac

ZIP_UPD="$OUT/BinFlow-$VERSION.zip"
ZIP_INST="$OUT/BinFlow-v$VERSION.zip"
for f in "$ZIP_UPD" "$ZIP_INST" "$OUT/latest.json"; do
    [ ! -e "$f" ] || { echo "❌ Ya existe $f. No se sobrescribe; bórralo a mano si quieres rehacerlo."; exit 1; }
done
mkdir -p "$OUT" || exit 1
OUT="$(cd "$OUT" && pwd)"
ZIP_UPD="$OUT/BinFlow-$VERSION.zip"
ZIP_INST="$OUT/BinFlow-v$VERSION.zip"

echo "📦 Empaquetando BinFlow v$VERSION..."
TMP="$(mktemp -d)" || exit 1
trap 'rm -rf "$TMP"' EXIT
cp -R "$PLUGIN" "$TMP/$PROJECT_NAME" || { echo "❌ La copia falló."; exit 1; }
find "$TMP" \( -name '.DS_Store' -o -name '._*' -o -name '.debug' -o -name 'tests' \) -prune -exec rm -rf {} + 2>/dev/null

check_zip() {
    if unzip -Z1 "$1" | grep -E '(^|/)(\.DS_Store|\._[^/]*|\.debug|tests)(/|$)|^/|\.\.' >/dev/null; then echo "❌ El zip $1 contiene archivos que no deben ir."; exit 1; fi
    if unzip -Z "$1" | grep -E '^[lbcps]' >/dev/null; then echo "❌ El zip $1 contiene enlaces simbólicos."; exit 1; fi
}

# 1. Zip del actualizador
( cd "$TMP" && zip -qry "$ZIP_UPD" "$PROJECT_NAME" -x '*.DS_Store' '*/._*' ) || { echo "❌ No se pudo crear el zip del actualizador."; exit 1; }
check_zip "$ZIP_UPD"
unzip -Z1 "$ZIP_UPD" | grep -qx "$PROJECT_NAME/CSXS/manifest.xml" || { echo "❌ Al zip le falta el manifest."; exit 1; }

# 2. Zip de instalación a mano
PKG="$TMP/inst/BinFlow-v$VERSION"
mkdir -p "$PKG" || exit 1
cp "installer/instalar_plugin.sh" "installer/Instalar BinFlow.command" "$PKG/" || exit 1
sed "s/{{VERSION}}/$VERSION/g" installer/LEEME.txt > "$PKG/LEEME.txt" || exit 1
chmod +x "$PKG/instalar_plugin.sh" "$PKG/Instalar BinFlow.command"
cp -R "$TMP/$PROJECT_NAME" "$PKG/$PROJECT_NAME" || exit 1
( cd "$TMP/inst" && zip -qry "$ZIP_INST" "BinFlow-v$VERSION" -x '*.DS_Store' '*/._*' ) || { echo "❌ No se pudo crear el zip de instalación."; exit 1; }
check_zip "$ZIP_INST"
unzip -Z1 "$ZIP_INST" | grep -qx "BinFlow-v$VERSION/Instalar BinFlow.command" || { echo "❌ Al zip de instalación le falta el .command."; exit 1; }

SHA="$(shasum -a 256 "$ZIP_UPD" | awk '{print $1}')"
SIZE="$(stat -f %z "$ZIP_UPD" 2>/dev/null || stat -c %s "$ZIP_UPD")"
SHA_INST="$(shasum -a 256 "$ZIP_INST" | awk '{print $1}')"
DATE="$(date +%Y-%m-%d)"
{
    printf '{\n  "version": "%s",\n  "date": "%s",\n  "url": "%s/BinFlow-%s.zip",\n  "sha256": "%s",\n  "size": %s,\n  "changelog": ' "$VERSION" "$DATE" "$URL_BASE" "$VERSION" "$SHA" "$SIZE"
    cat "$CHANGELOG"
    printf '\n}\n'
} > "$OUT/latest.json"

if command -v node >/dev/null 2>&1; then node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$OUT/latest.json" || { echo "❌ latest.json no es JSON válido."; exit 1; }
elif command -v python3 >/dev/null 2>&1; then python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$OUT/latest.json" || { echo "❌ latest.json no es JSON válido."; exit 1; }
fi

echo "✅ Listo en $OUT/"
echo "   BinFlow-$VERSION.zip   (actualizador)    sha256 $SHA"
echo "   BinFlow-v$VERSION.zip  (instalación)     sha256 $SHA_INST"
echo "   latest.json"
echo ""
echo "➡️  Esto NO sube nada. Para publicar (a mano): Release v$VERSION con los dos zips como assets, y latest.json en la raíz de main."
