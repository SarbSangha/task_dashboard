# check_tasks.py - Verify database integrity
import sys
sys.path.append('.')

from .database_config import OperationalSessionLocal
from .models_new import User, Task, TaskParticipant

def check_database():
    """Check database status"""
    db = OperationalSessionLocal()
    
    try:
        print("\n" + "="*60)
        print("DATABASE VERIFICATION")
        print("="*60)
        
        # Check users
        users = db.query(User).all()
        print(f"\n👥 Users: {len(users)}")
        for user in users:
            print(f"  - {user.name} ({user.email})")
        
        # Check tasks
        tasks = db.query(Task).all()
        tasks_with_creator = db.query(Task).filter(Task.creator_id != None).all()
        tasks_without_creator = db.query(Task).filter(Task.creator_id == None).all()
        
        print(f"\n📋 Tasks: {len(tasks)} total")
        print(f"  ✅ With creator: {len(tasks_with_creator)}")
        print(f"  ❌ Without creator: {len(tasks_without_creator)}")
        
        # Check by user
        if tasks_with_creator:
            print(f"\n📊 Tasks by User:")
            user_counts = {}
            for task in tasks_with_creator:
                user_id = task.creator_id
                user = db.query(User).filter(User.id == user_id).first()
                if user:
                    user_counts[user.name] = user_counts.get(user.name, 0) + 1
            
            for user_name, count in user_counts.items():
                print(f"  - {user_name}: {count} tasks")
        
        print("\n" + "="*60)
        
    except Exception as e:
        print(f"❌ Error: {str(e)}")
    finally:
        db.close()

if __name__ == "__main__":
    check_database()
