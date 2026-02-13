# recreate_db.py
from database import engine, Base, SessionLocal, User
from passlib.context import CryptContext

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

print("⚠️  Recreating database with position column...")

# Drop and recreate
Base.metadata.drop_all(bind=engine)
Base.metadata.create_all(bind=engine)

print("✅ Database recreated!")

# Create test user
db = SessionLocal()
test_user = User(
    name="Test User",
    email="test@example.com",
    hashed_password=pwd_context.hash("password123"),
    position="Developer",
    department="Engineering",
    is_active=True
)
db.add(test_user)
db.commit()
print(f"✅ Test user created: {test_user.email} ({test_user.position})")
db.close()
