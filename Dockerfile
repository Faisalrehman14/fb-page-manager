FROM php:8.2-apache

# System dependencies for PHP extensions
RUN apt-get update && apt-get install -y \
    libpng-dev \
    libwebp-dev \
    libjpeg62-turbo-dev \
    libfreetype6-dev \
    libcurl4-openssl-dev \
    libonig-dev \
    && rm -rf /var/lib/apt/lists/*

# PHP extensions
RUN docker-php-ext-configure gd --with-freetype --with-jpeg --with-webp \
    && docker-php-ext-install \
        pdo \
        pdo_mysql \
        gd \
        mbstring \
        curl \
        fileinfo

# Disable conflicting MPMs, enable only prefork
RUN a2dismod mpm_event mpm_worker 2>/dev/null || true \
    && a2enmod mpm_prefork rewrite headers expires deflate

RUN echo "ServerName localhost" >> /etc/apache2/apache2.conf

# Apache virtual host config
COPY docker/000-default.conf /etc/apache2/sites-available/000-default.conf

# Copy application files (excluding .env — set via Railway env vars)
COPY . /var/www/html/

# Remove .env from image for security
RUN rm -f /var/www/html/.env

# Create uploads directory and fix permissions
RUN mkdir -p /var/www/html/uploads \
    && chown -R www-data:www-data /var/www/html \
    && chmod -R 755 /var/www/html \
    && chmod 775 /var/www/html/uploads

# Startup script
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 80

ENTRYPOINT ["/entrypoint.sh"]
