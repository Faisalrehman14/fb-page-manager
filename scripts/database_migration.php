<?php
/**
 * scripts/database_migration.php
 * ═════════════════════════════════════════════════════════════
 * Database schema migration system with version tracking
 * 
 * Usage:
 *   php scripts/database_migration.php status    # Check migration status
 *   php scripts/database_migration.php migrate   # Run pending migrations
 *   php scripts/database_migration.php rollback  # Roll back last migration
 */

require_once __DIR__ . '/../config/load-env.php';
require_once __DIR__ . '/../db_config.php';
require_once __DIR__ . '/../config/logger.php';

$db = getDB();
$command = $argv[1] ?? 'status';

// Ensure migrations table exists
$db->exec("
    CREATE TABLE IF NOT EXISTS `migrations` (
        `id` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        `name` VARCHAR(255) NOT NULL UNIQUE,
        `batch` INT UNSIGNED NOT NULL,
        `executed_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
");

// Define migrations directory
$migrations_dir = __DIR__ . '/migrations';
if (!is_dir($migrations_dir)) {
    mkdir($migrations_dir, 0755, true);
}

class Migration {
    private $db;
    private $migrations_dir;
    
    public function __construct($db, $migrations_dir) {
        $this->db = $db;
        $this->migrations_dir = $migrations_dir;
    }
    
    public function status() {
        $stmt = $this->db->query("SELECT * FROM migrations ORDER BY batch DESC, id DESC");
        $executed = $stmt->fetchAll(PDO::FETCH_ASSOC);
        
        $all_files = $this->getMigrationFiles();
        $executed_names = array_column($executed, 'name');
        $pending = array_diff($all_files, $executed_names);
        
        echo "═══════════════════════════════════════════════════════════\n";
        echo "Migration Status\n";
        echo "═══════════════════════════════════════════════════════════\n\n";
        
        if (!empty($executed)) {
            echo "✅ Executed Migrations:\n";
            foreach ($executed as $m) {
                echo "  • " . $m['name'] . " (Batch " . $m['batch'] . ")\n";
            }
            echo "\n";
        }
        
        if (!empty($pending)) {
            echo "⏳ Pending Migrations:\n";
            foreach ($pending as $m) {
                echo "  • " . $m . "\n";
            }
            echo "\n";
        } else {
            echo "✅ All migrations executed!\n\n";
        }
    }
    
    public function migrate() {
        $stmt = $this->db->query("SELECT MAX(batch) as max_batch FROM migrations");
        $result = $stmt->fetch(PDO::FETCH_ASSOC);
        $next_batch = ($result['max_batch'] ?? 0) + 1;
        
        $all_files = $this->getMigrationFiles();
        $stmt = $this->db->query("SELECT name FROM migrations");
        $executed_names = $stmt->fetchAll(PDO::FETCH_COLUMN);
        $pending = array_diff($all_files, $executed_names);
        
        if (empty($pending)) {
            echo "✅ No pending migrations.\n";
            return;
        }
        
        echo "Running " . count($pending) . " pending migration(s)...\n\n";
        
        $failed = [];
        foreach ($pending as $migration_name) {
            echo "Migrating: $migration_name ... ";
            
            try {
                $this->executeMigration($migration_name);
                
                $stmt = $this->db->prepare("
                    INSERT INTO migrations (name, batch) VALUES (?, ?)
                ");
                $stmt->execute([$migration_name, $next_batch]);
                
                echo "✅\n";
                logger('info', "Migration executed: $migration_name");
            } catch (Exception $e) {
                echo "❌\n";
                echo "  Error: " . $e->getMessage() . "\n";
                $failed[] = [$migration_name, $e->getMessage()];
                logger('error', "Migration failed: $migration_name", ['error' => $e->getMessage()]);
            }
        }
        
        if (empty($failed)) {
            echo "\n✅ All migrations completed successfully!\n";
        } else {
            echo "\n❌ " . count($failed) . " migration(s) failed:\n";
            foreach ($failed as [$name, $error]) {
                echo "  • $name: $error\n";
            }
        }
    }
    
    public function rollback() {
        $stmt = $this->db->query("
            SELECT * FROM migrations 
            WHERE batch = (SELECT MAX(batch) FROM migrations)
            ORDER BY id DESC
        ");
        $migrations = $stmt->fetchAll(PDO::FETCH_ASSOC);
        
        if (empty($migrations)) {
            echo "Nothing to roll back.\n";
            return;
        }
        
        echo "Rolling back " . count($migrations) . " migration(s)...\n\n";
        
        foreach ($migrations as $m) {
            echo "Rolling back: " . $m['name'] . " ... ";
            
            try {
                // You can implement rollback methods in each migration file
                // For now, just remove from tracking
                $stmt = $this->db->prepare("DELETE FROM migrations WHERE id = ?");
                $stmt->execute([$m['id']]);
                echo "✅\n";
            } catch (Exception $e) {
                echo "❌\n";
            }
        }
        
        echo "\n✅ Rollback completed!\n";
    }
    
    private function executeMigration($migration_name) {
        $file = $this->migrations_dir . '/' . $migration_name . '.php';
        
        if (!file_exists($file)) {
            throw new Exception("Migration file not found: $file");
        }
        
        include $file;
    }
    
    private function getMigrationFiles() {
        $files = [];
        
        if (!is_dir($this->migrations_dir)) {
            return $files;
        }
        
        $dir = opendir($this->migrations_dir);
        while (($file = readdir($dir)) !== false) {
            if ($file === '.' || $file === '..') continue;
            if (substr($file, -4) !== '.php') continue;
            
            $files[] = substr($file, 0, -4);
        }
        closedir($dir);
        
        sort($files);
        return $files;
    }
}

// Execute command
$migrator = new Migration($db, $migrations_dir);

switch ($command) {
    case 'status':
        $migrator->status();
        break;
    
    case 'migrate':
        $migrator->migrate();
        break;
    
    case 'rollback':
        $migrator->rollback();
        break;
    
    default:
        echo "Available commands: status, migrate, rollback\n";
}
