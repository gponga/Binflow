#!/bin/bash
cd "$(dirname "$0")" || exit 1
chmod +x ./instalar_plugin.sh
./instalar_plugin.sh
echo; echo "Listo. Cierra Premiere del todo y vuelve a abrirlo. Ventana > Extensiones > BinFlow."
read -n 1 -s -r -p "Pulsa una tecla para cerrar..."
