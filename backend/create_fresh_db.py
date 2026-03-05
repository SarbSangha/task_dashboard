# create_fresh_db.py - Create fresh databases
import sys
sys.path.append('.')

from database_config import (
    operational_engine,
    archive_engine,
    Base,
    ArchiveBase,
    OPERATIONAL_DB_URL,
    ARCHIVE_DB_URL,
)
from models_new import *

def create_databases():
    """Create fresh databases"""
    print("\n" + "="*60)
    print("CREATING FRESH DATABASES")
    print("="*60)
    
    # Create operational database
    print("\n📊 Creating operational database...")
    Base.metadata.create_all(bind=operational_engine)
    print(f"✅ Created/Verified: {OPERATIONAL_DB_URL}")
    
    # Create archive database
    print("\n📦 Creating archive database...")
    ArchiveBase.metadata.create_all(bind=archive_engine)
    print(f"✅ Created/Verified: {ARCHIVE_DB_URL}")
    
    print("\n" + "="*60)
    print("✅ FRESH DATABASES CREATED!")
    print("="*60)
    print("\nYou can now:")
    print("1. Start your server: uvicorn main:app --reload")
    print("2. Register new users")
    print("3. Create tasks\n")

if __name__ == "__main__":
    create_databases()
