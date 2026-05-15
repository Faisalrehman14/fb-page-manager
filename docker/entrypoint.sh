#!/bin/bash
set -e

# Fix MPM at runtime — remove all MPM modules, enable only prefork
echo "Fixing Apache MPM..."
rm -f /etc/apache2/mods-enabled/mpm_event.conf \
      /etc/apache2/mods-enabled/mpm_event.load \
      /etc/apache2/mods-enabled/mpm_worker.conf \
      /etc/apache2/mods-enabled/mpm_worker.load
[ -f /etc/apache2/mods-enabled/mpm_prefork.conf ] || \
    ln -s /etc/apache2/mods-available/mpm_prefork.conf /etc/apache2/mods-enabled/mpm_prefork.conf
[ -f /etc/apache2/mods-enabled/mpm_prefork.load ] || \
    ln -s /etc/apache2/mods-available/mpm_prefork.load /etc/apache2/mods-enabled/mpm_prefork.load
echo "MPM fixed. Active MPM files:"
ls /etc/apache2/mods-enabled/mpm_*

# Railway provides $PORT — Apache must listen on it
PORT="${PORT:-80}"

# Update Apache ports
sed -i "s/Listen 80/Listen $PORT/" /etc/apache2/ports.conf
sed -i "s/Listen 443/Listen 443/" /etc/apache2/ports.conf 2>/dev/null || true

# Inject PORT into virtual host config
sed -i "s/__PORT__/$PORT/g" /etc/apache2/sites-available/000-default.conf

# Ensure uploads and logs directories exist and are writable
mkdir -p /var/www/html/uploads /var/www/html/logs
chown -R www-data:www-data /var/www/html/uploads /var/www/html/logs
chmod 775 /var/www/html/uploads /var/www/html/logs

echo "Testing Apache configuration..."
apache2ctl configtest 2>&1

echo "Starting Apache on port $PORT..."
exec apache2-foreground 2>&1
